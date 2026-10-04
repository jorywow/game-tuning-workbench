#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { patchNumericBinding } from "./apply-engine.mjs";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".glb", ".gltf", ".mp3", ".wav", ".ogg",
]);
const SKIP_DIRECTORIES = new Set([
  ".git", ".game-tuning", ".game-tuning-workbench", "node_modules", "dist", "build", "coverage", ".next", ".vite",
]);
const MAX_SOURCE_BYTES = 1024 * 1024;

const GROUP_META = {
  player: {
    ownerId: "system.player",
    group: "controls",
    excluded: ["不会自动改写武器参数", "不会自动改写敌人参数"],
  },
  weapon: {
    ownerId: "system.weapon",
    group: "combat-pressure",
    excluded: ["不会自动改写玩家移动参数", "不会自动改写敌人生命参数"],
  },
  enemy: {
    ownerId: "system.enemy",
    group: "combat-pressure",
    excluded: ["不会自动改写玩家移动参数", "不会自动改写武器参数"],
  },
  mission: {
    ownerId: "system.mission",
    group: "pacing",
    excluded: ["不会自动改写武器伤害", "不会自动替换场景素材"],
  },
  boss: {
    ownerId: "system.boss",
    group: "combat-pressure",
    excluded: ["不会自动改写普通敌人参数", "不会自动改写玩家移动参数"],
  },
  visual: {
    ownerId: "system.visual",
    group: "visual-feedback",
    excluded: ["不会自动改写战斗伤害", "不会自动改写任务波次"],
  },
};

const EVENT_RULES = {
  shot: ["玩家开火", "结算一次射击并产生枪口、弹道或弹药反馈"],
  hit: ["攻击命中目标", "结算命中结果并向玩家确认命中"],
  damage: ["角色受到伤害", "扣除生命并显示受伤反馈"],
  death: ["角色或敌人生命归零", "进入死亡处理并清理或推进状态"],
  "wave-start": ["新一波战斗开始", "更新目标并生成这一波敌人"],
  "wave-complete": ["当前波次敌人被清除", "发放波次结束反馈并准备下一阶段"],
  "mission-complete": ["当前任务目标完成", "推进到后续任务或首领战"],
  "mission-failed": ["玩家未能完成任务", "进入失败结算"],
  "level-complete": ["关卡目标完成", "进入胜利结算"],
  "level-failed": ["关卡失败条件满足", "进入失败结算"],
};

export class UnsupportedThreeProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedThreeProjectError";
  }
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function stablePart(value) {
  const normalized = String(value)
    .normalize("NFKD")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || "unknown";
}

function lineNumberAt(text, index) {
  return text.slice(0, Math.max(0, index)).split("\n").length;
}

function stripStringsAndComments(text) {
  let output = "";
  let state = "code";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line-comment";
      } else if (char === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block-comment";
      } else if (char === "'" || char === '"' || char === "`") {
        output += " ";
        quote = char;
        state = "string";
      } else {
        output += char;
      }
    } else if (state === "string") {
      if (char === "\\") {
        output += " ";
        if (index + 1 < text.length) {
          output += text[index + 1] === "\n" ? "\n" : " ";
          index += 1;
        }
      } else if (char === quote) {
        output += " ";
        state = "code";
        quote = null;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
    } else if (state === "line-comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "code";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
    }
  }
  return output;
}

function getPath(target, path) {
  return path.split(".").reduce((value, key) => value?.[key], target);
}

function mimeTypeForExtension(extension) {
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  }[extension] ?? "application/octet-stream";
}

function assetCategory(path) {
  const lower = path.toLowerCase();
  if (/enemy|hostile|boss/.test(lower)) return "enemy";
  if (/player|hero|weapon|gun/.test(lower)) return "player";
  if (/particle|effect|fx|impact|muzzle/.test(lower)) return "effect";
  if (/ui|hud|icon|button/.test(lower)) return "ui";
  if (/audio|music|sound|voice/.test(lower) || /\.(mp3|wav|ogg)$/.test(lower)) return "audio";
  if (/\.(glb|gltf)$/.test(lower)) return "model";
  return "environment";
}

async function walkProject(root, maxFiles) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  await visit(root);
  return files;
}

async function loadSources(projectRoot, files) {
  const records = [];
  for (const absolutePath of files) {
    if (!SOURCE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) continue;
    const relativePath = toPosix(relative(projectRoot, absolutePath));
    if (/^(tests?|__tests__|tools|scripts|docs)\//.test(relativePath)) continue;
    const fileStats = await stat(absolutePath);
    if (fileStats.size > MAX_SOURCE_BYTES) continue;
    records.push({
      absolutePath,
      relativePath,
      text: await readFile(absolutePath, "utf8"),
    });
  }
  return records;
}

async function loadPackage(projectRoot) {
  try {
    return JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to parse package.json: ${error.message}`);
  }
}

function detectThreeVersion(packageJson) {
  const raw = packageJson?.dependencies?.three ?? packageJson?.devDependencies?.three ?? null;
  if (!raw) return null;
  const match = String(raw).match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? String(raw);
}

function detectsThree(packageJson, sources) {
  if (packageJson?.dependencies?.three || packageJson?.devDependencies?.three) return true;
  return sources.some(({ text }) => /from\s+["']three["']|require\(["']three["']\)/.test(text));
}

async function detectEntryPoints(projectRoot, files, sources) {
  const entries = new Set();
  const indexPath = files.find((path) => toPosix(relative(projectRoot, path)) === "index.html");
  if (indexPath) {
    const html = await readFile(indexPath, "utf8");
    for (const match of html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/g)) {
      entries.add(match[1].replace(/^\//, ""));
    }
  }
  for (const candidate of ["src/main.js", "src/main.ts", "src/index.js", "src/index.ts", "main.js", "main.ts"]) {
    if (sources.some((source) => source.relativePath === candidate)) entries.add(candidate);
  }
  if (entries.size === 0) {
    const firstThreeImport = sources.find(({ text }) => /from\s+["']three["']|require\(["']three["']\)/.test(text));
    if (firstThreeImport) entries.add(firstThreeImport.relativePath);
  }
  return [...entries];
}

function detectRuntimeRoots(sources) {
  const roots = new Set();
  for (const source of sources) {
    const parts = source.relativePath.split("/");
    const gameIndex = parts.findIndex((part) => /^(game|engine|runtime|scene|world|systems?)$/i.test(part));
    if (gameIndex >= 0) roots.add(parts.slice(0, gameIndex + 1).join("/"));
  }
  if (roots.size === 0 && sources.some((source) => source.relativePath.startsWith("src/"))) roots.add("src");
  return [...roots];
}

function createEvidenceRegistry() {
  const items = [];
  const ids = new Set();
  return {
    add(baseId, value) {
      let id = baseId;
      let suffix = 2;
      while (ids.has(id)) id = `${baseId}-${suffix++}`;
      ids.add(id);
      items.push({ id, ...value });
      return id;
    },
    items,
  };
}

function extractDocumentTitle(indexHtml) {
  return indexHtml?.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
}

function extractObjectiveStrings(sources) {
  const objectives = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(/objective\s*:\s*["'`]([^"'`]{3,100})["'`]/g)) {
      if (!objectives.some((item) => item.text === match[1])) {
        objectives.push({ text: match[1], source, index: match.index ?? 0 });
      }
      if (objectives.length >= 5) return objectives;
    }
  }
  return objectives;
}

function findStructuredTuningSource(sources) {
  return sources.find(({ text }) => text.includes("DEFAULT_TUNING") && text.includes("TUNING_SCHEMA")) ?? null;
}

function extractDefaultTuning(source) {
  const values = {};
  const lineHints = new Map();
  const start = source.text.indexOf("DEFAULT_TUNING");
  const end = source.text.indexOf("TUNING_SCHEMA", start + 1);
  if (start < 0 || end < 0) return { values, lineHints };
  const block = source.text.slice(start, end);
  let activeGroup = null;
  const lines = block.split("\n");
  const startingLine = lineNumberAt(source.text, start) - 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const groupMatch = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:Object\.freeze\()?\s*\{/);
    if (groupMatch) {
      activeGroup = groupMatch[1];
      values[activeGroup] ??= {};
      continue;
    }
    const valueMatch = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*,?/i);
    if (activeGroup && valueMatch) {
      const path = `${activeGroup}.${valueMatch[1]}`;
      values[activeGroup][valueMatch[1]] = Number(valueMatch[2]);
      lineHints.set(path, startingLine + index + 1);
    }
    if (activeGroup && /^\s*}\)?\s*,?\s*$/.test(line)) activeGroup = null;
  }
  return { values, lineHints };
}

function extractTuningFields(source) {
  const start = source.text.indexOf("TUNING_SCHEMA");
  if (start < 0) return [];
  const end = source.text.indexOf("TUNING_PRESETS", start + 1) < 0
    ? source.text.length : source.text.indexOf("TUNING_PRESETS", start + 1);
  const block = source.text.slice(start, end);
  const fields = [];
  const tuplePattern = /\[\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*,\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*,\s*((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*,\s*["']([^"']+)["']\s*\]/gi;
  for (const match of block.matchAll(tuplePattern)) {
    fields.push({
      path: match[1],
      label: match[2],
      min: Number(match[3]),
      max: Number(match[4]),
      step: Number(match[5]),
      effect: match[6],
      lineHint: lineNumberAt(source.text, start + (match.index ?? 0)),
    });
  }
  return fields;
}

function findConsumers(fieldPath, sources) {
  const [group, leaf] = fieldPath.split(".");
  const directMember = new RegExp(`\\.\\s*${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const groupHints = {
    player: /player|controller/i,
    weapon: /weapon|gun/i,
    enemy: /enemy/i,
    mission: /mission|wave|director|main/i,
    boss: /boss/i,
  }[group] ?? /.*/;
  const matches = sources
    .map((source) => ({ source, code: stripStringsAndComments(source.text) }))
    .filter(({ code }) => directMember.test(code))
    .map(({ source, code }) => ({
      source,
      score: groupHints.test(source.relativePath) ? 2 : source.relativePath.endsWith("main.js") ? 1 : 0,
      index: code.search(directMember),
    }))
    .sort((left, right) => right.score - left.score || left.source.relativePath.localeCompare(right.source.relativePath));
  const bestScore = matches[0]?.score ?? 0;
  const scopedMatches = bestScore >= 2 ? matches.filter((match) => match.score === bestScore) : matches;
  return scopedMatches.slice(0, 4);
}

function describeParameter(label, path) {
  const lower = `${label} ${path}`.toLowerCase();
  if (/cooldown|interval|duration|时间|间隔|冷却|换弹/.test(lower)) {
    return { lower: `${label}更短，相关动作发生得更快`, higher: `${label}更长，玩家拥有更多间隔或等待时间` };
  }
  if (/damage|伤害|火力/.test(lower)) {
    return { lower: `${label}更低，攻击威胁或输出下降`, higher: `${label}更高，攻击威胁或输出上升` };
  }
  if (/health|durability|生命|耐久/.test(lower)) {
    return { lower: `${label}更低，目标更容易被击败`, higher: `${label}更高，目标能承受更多伤害` };
  }
  if (/speed|速度|射速|加速度|灵敏度/.test(lower)) {
    return { lower: `${label}更低，动作或响应更慢`, higher: `${label}更高，动作或响应更快` };
  }
  if (/count|ammo|magazine|弹药|弹匣|数量/.test(lower)) {
    return { lower: `${label}更少，可用资源或场上数量下降`, higher: `${label}更多，可用资源或场上数量上升` };
  }
  if (/spread|recoil|散布|后坐力/.test(lower)) {
    return { lower: `${label}更低，武器更稳定`, higher: `${label}更高，武器更难控制` };
  }
  return { lower: `${label}的数值更低`, higher: `${label}的数值更高` };
}

function groupMetadata(group) {
  return GROUP_META[group] ?? {
    ownerId: `system.${stablePart(group)}`,
    group: "pacing",
    excluded: ["不会自动改写其他配置项"],
  };
}

function reachableRuntimeSources(sources, entryPoints) {
  const byPath = new Map(sources.map(source => [source.relativePath, source]));
  const visited = new Set();
  const pending = [...entryPoints];
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path) || !byPath.has(path)) continue;
    visited.add(path);
    const source = byPath.get(path);
    for (const match of source.text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)["'](\.[^"']+)["']/g)) {
      const base = toPosix(normalize(join(dirname(path), match[1])));
      for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.jsx`, `${base}.tsx`, `${base}/index.js`, `${base}/index.ts`]) {
        if (byPath.has(candidate)) { pending.push(candidate); break; }
      }
    }
  }
  return sources.filter(source => visited.has(source.relativePath));
}

const CONVENTIONAL_FIELD = /speed|damage|health|hearts|stamina|energy|cooldown|duration|recovery|responsiveness|invulnerability|knockback|acceleration|jump|gravity|fireRate|reload|ammo|magazine|range/i;
const CONVENTIONAL_ROOT = /(?:DEFAULTS?|CONFIG|SETTINGS|TUNING|BALANCE|PARAMS)$/i;

function conventionalRange(value) {
  if (value <= 0) return null;
  if (Number.isInteger(value)) return { min: Math.max(0, Math.floor(value * 0.5)), max: Math.ceil(value * 1.5), step: 1 };
  const precision = (String(value).split(".")[1] ?? "").length;
  const step = Number((10 ** -Math.min(precision + 1, 3)).toFixed(3));
  const round = number => Number(number.toFixed(Math.min(precision + 1, 3)));
  return { min: round(Math.max(step, value * 0.5)), max: round(value * 1.5), step };
}

function analyzeConventionalTuning(sources, evidence) {
  const parameters = [];
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const rootMatch = lines[index].match(/^\s*(?:export\s+)?const\s+([A-Z][A-Z\d_]*)\s*=\s*(?:Object\.freeze\()?\{\s*$/);
      if (!rootMatch || !CONVENTIONAL_ROOT.test(rootMatch[1])) continue;
      const root = rootMatch[1];
      let end = index + 1;
      while (end < lines.length && !/^\s*}\)?\s*;?\s*$/.test(lines[end])) end += 1;
      if (end >= lines.length || end - index > 100) continue;
      const block = lines.slice(index + 1, end);
      if (block.some(line => /^\s*[A-Za-z_$][\w$]*\s*:\s*(?:Object\.freeze\()?\s*\{/.test(line))) continue;
      const code = stripStringsAndComments(source.text.slice(lines.slice(0, end + 1).join("\n").length));
      const spread = new RegExp(`\\bthis\\.config\\s*=\\s*\\{\\s*\\.\\.\\.${root}\\b`).test(code);
      const candidates = [];
      for (let offset = 0; offset < block.length; offset += 1) {
        const match = block[offset].match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*,?\s*(?:\/\/.*)?$/i);
        if (!match || !CONVENTIONAL_FIELD.test(match[1])) continue;
        const value = Number(match[2]);
        const range = conventionalRange(value);
        if (!range || value <= range.min || value >= range.max) continue;
        const field = match[1];
        const direct = new RegExp(`\\b${root}\\s*\\.\\s*${field}\\b`).test(code);
        const copied = spread && new RegExp(`\\bthis\\.config\\s*\\.\\s*${field}\\b`).test(code);
        if (!direct && !copied) continue;
        const binding = { file: source.relativePath, symbol: `${root}.${field}`, lineHint: index + offset + 2, access: "editable" };
        try { patchNumericBinding(source.text, binding, value, value); } catch { continue; }
        candidates.push({ field, value, range, lineHint: index + offset + 2, consumer: copied ? `this.config.${field}` : `${root}.${field}`, copied });
      }
      if (!candidates.length) continue;
      const owner = /player|flight|controller|movement/i.test(source.relativePath) ? "player"
        : /enemy|boss/i.test(source.relativePath) ? "enemy"
          : /weapon|combat|attack/i.test(source.relativePath) ? "weapon" : "game";
      const meta = groupMetadata(owner);
      for (const candidate of candidates) {
        const label = candidate.field.replace(/([a-z\d])([A-Z])/g, "$1 $2");
        const declarationEvidence = evidence.add(`evidence.tuning-${stablePart(root)}-${stablePart(candidate.field)}-declaration`, {
          kind: "configuration", file: source.relativePath, symbol: `${root}.${candidate.field}`,
          details: `Numeric default ${candidate.field} is declared in ${root}.`, confidence: "confirmed",
        });
        const consumerEvidence = evidence.add(`evidence.tuning-${stablePart(root)}-${stablePart(candidate.field)}-consumer`, {
          kind: "source-code", file: source.relativePath, symbol: candidate.consumer,
          details: `${candidate.consumer} reads this value in production source.`, confidence: "confirmed",
        });
        parameters.push({
          id: `tuning.${stablePart(source.relativePath)}-${stablePart(root)}-${stablePart(candidate.field)}`,
          ownerId: meta.ownerId, group: meta.group, label, description: `${label} 的运行时默认值。`,
          playerMeaning: describeParameter(label, candidate.field),
          valueType: Number.isInteger(candidate.value) ? "integer" : "number", unit: null,
          currentValue: candidate.value, defaultValue: candidate.value, safeRange: candidate.range,
          control: "slider",
          sourceBinding: { file: source.relativePath, symbol: `${root}.${candidate.field}`, lineHint: candidate.lineHint, access: "editable" },
          previewBinding: { consumer: `${source.relativePath}:${candidate.consumer}`, mode: "restart-game" },
          effects: { direct: [`改变 ${label} 的默认值`], indirect: candidate.copied ? ["运行时传入的配置可能覆盖此默认值，需在试玩中验证"] : [], excluded: meta.excluded },
          confidence: "confirmed", evidenceRefs: [declarationEvidence, consumerEvidence],
        });
      }
      index = end;
    }
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*(?:export\s+)?const\s+([A-Z][A-Z\d_]*)\s*=\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*;?\s*(?:\/\/.*)?$/);
      if (!match || !CONVENTIONAL_FIELD.test(match[1])) continue;
      const [_, name, literal] = match;
      const value = Number(literal);
      const range = conventionalRange(value);
      if (!range || value <= range.min || value >= range.max) continue;
      const laterCode = stripStringsAndComments(lines.slice(index + 1).join("\n"));
      if (!new RegExp(`\\b${name}\\b`).test(laterCode)) continue;
      const binding = { file: source.relativePath, symbol: name, lineHint: index + 1, access: "editable" };
      try { patchNumericBinding(source.text, binding, value, value); } catch { continue; }
      const owner = /player|flight|controller|movement/i.test(source.relativePath) ? "player"
        : /enemy|boss/i.test(source.relativePath) ? "enemy"
          : /weapon|combat|attack/i.test(source.relativePath) ? "weapon" : "game";
      const meta = groupMetadata(owner);
      const label = name.toLowerCase().replaceAll("_", " ");
      const declarationEvidence = evidence.add(`evidence.tuning-${stablePart(name)}-declaration`, {
        kind: "configuration", file: source.relativePath, symbol: name,
        details: `Numeric constant ${name} is declared in production source.`, confidence: "confirmed",
      });
      const consumerEvidence = evidence.add(`evidence.tuning-${stablePart(name)}-consumer`, {
        kind: "source-code", file: source.relativePath, symbol: name,
        details: `${source.relativePath} reads ${name} after its declaration.`, confidence: "confirmed",
      });
      parameters.push({
        id: `tuning.${stablePart(source.relativePath)}-${stablePart(name)}`,
        ownerId: meta.ownerId, group: meta.group, label, description: `${label} 的运行时常量。`,
        playerMeaning: describeParameter(label, name), valueType: Number.isInteger(value) ? "integer" : "number", unit: null,
        currentValue: value, defaultValue: value, safeRange: range, control: "slider",
        sourceBinding: binding,
        previewBinding: { consumer: `${source.relativePath}:${name}`, mode: "restart-game" },
        effects: { direct: [`改变 ${label} 的运行时数值`], indirect: [], excluded: meta.excluded },
        confidence: "confirmed", evidenceRefs: [declarationEvidence, consumerEvidence],
      });
    }
  }
  return parameters;
}

function analyzeTuning(sources, runtimeSources, evidence, limitations) {
  const tuningSource = findStructuredTuningSource(sources);
  if (!tuningSource) {
    const parameters = analyzeConventionalTuning(runtimeSources, evidence);
    if (!parameters.length) limitations.push("未发现已被运行时代码读取的显式调优契约或常见配置默认值；内联数字需要先由 Codex 接入配置，不能直接生成滑杆。" );
    return { parameters, adapter: parameters.length ? "conventional-config" : "none", source: null, skippedFields: [] };
  }

  const defaults = extractDefaultTuning(tuningSource);
  const fields = extractTuningFields(tuningSource);
  const parameters = [];
  const skippedFields = [];

  for (const field of fields) {
    const currentValue = getPath(defaults.values, field.path);
    const consumers = findConsumers(field.path, sources);
    if (!Number.isFinite(currentValue) || consumers.length === 0) {
      skippedFields.push({ path: field.path, reason: !Number.isFinite(currentValue) ? "missing-default" : "missing-runtime-consumer" });
      continue;
    }

    const declarationEvidence = evidence.add(`evidence.tuning-${stablePart(field.path)}-declaration`, {
      kind: "configuration",
      file: tuningSource.relativePath,
      symbol: `DEFAULT_TUNING.${field.path}`,
      details: `TUNING_SCHEMA declares ${field.path} with range ${field.min}..${field.max} and step ${field.step}.`,
      confidence: "confirmed",
    });
    const consumerEvidence = consumers.map(({ source, index }) => evidence.add(
      `evidence.tuning-${stablePart(field.path)}-consumer`,
      {
        kind: "source-code",
        file: source.relativePath,
        symbol: field.path.split(".").at(-1),
        details: `${source.relativePath} reads the ${field.path.split(".").at(-1)} runtime value.`,
        confidence: "confirmed",
      },
    ));
    const [group] = field.path.split(".");
    const meta = groupMetadata(group);
    const meaning = describeParameter(field.label, field.path);
    const mode = field.effect.includes("重开") ? "restart-game" : field.effect === "立即" ? "live" : "restart-scene";
    parameters.push({
      id: `tuning.${stablePart(field.path)}`,
      ownerId: meta.ownerId,
      group: meta.group,
      label: field.label,
      description: `${field.label}，原项目标注为“${field.effect}”生效。`,
      playerMeaning: meaning,
      valueType: Number.isInteger(currentValue) && Number.isInteger(field.step) ? "integer" : "number",
      unit: field.label.includes("RPM") ? "RPM" : /时间|间隔|冷却/.test(field.label) ? "秒" : null,
      currentValue,
      defaultValue: currentValue,
      safeRange: { min: field.min, max: field.max, step: field.step },
      control: "slider",
      sourceBinding: {
        file: tuningSource.relativePath,
        symbol: `DEFAULT_TUNING.${field.path}`,
        lineHint: defaults.lineHints.get(field.path) ?? field.lineHint,
        access: "editable",
      },
      previewBinding: {
        consumer: consumers.map(({ source }) => `${source.relativePath}:${field.path.split(".").at(-1)}`).join(", "),
        mode,
      },
      effects: {
        direct: [`改变“${field.label}”的运行时数值`],
        indirect: consumers.length > 1 ? [`该值被 ${consumers.length} 个运行时文件读取，需要在相关场景中共同验证`] : [],
        excluded: meta.excluded,
      },
      confidence: "confirmed",
      evidenceRefs: [declarationEvidence, ...consumerEvidence],
    });
  }

  if (skippedFields.length > 0) {
    limitations.push(`${skippedFields.length} 个显式调优字段因缺少默认值或运行时消费者而未生成控件。`);
  }
  if (parameters.length === 0) {
    const conventional = analyzeConventionalTuning(runtimeSources, evidence);
    if (conventional.length) return { parameters: conventional, adapter: "conventional-config", source: null, skippedFields };
  }
  return { parameters, adapter: "explicit-tuning-schema", source: tuningSource.relativePath, skippedFields };
}

function detectSystems(sources, evidence) {
  const definitions = [
    ["player", /PlayerController|InputSystem|Player\.([jt]s|tsx?)$/i, "玩家输入与移动系统"],
    ["weapon", /WeaponSystem|WeaponView|GunSystem/i, "武器与攻击系统"],
    ["enemy", /EnemySystem|EnemyFactory/i, "普通敌人系统"],
    ["mission", /CombatDirector|Mission|WaveDirector/i, "任务与波次系统"],
    ["level", /LevelDirector|StageDirector/i, "关卡推进系统"],
    ["boss", /BossSystem/i, "首领战系统"],
  ];
  const systems = new Map();
  for (const [id, pattern, details] of definitions) {
    const source = sources.find((candidate) => pattern.test(candidate.relativePath));
    if (!source) continue;
    const evidenceId = evidence.add(`evidence.system-${id}`, {
      kind: "source-code",
      file: source.relativePath,
      details: `${details} is implemented in ${source.relativePath}.`,
      confidence: "confirmed",
    });
    systems.set(id, { source, evidenceId });
  }
  return systems;
}

function buildCoreGameplay(sources, systems, evidence) {
  const loopSteps = [];
  const addStep = (id, playerAction, gameResponse, reward, risk, evidenceRefs) => {
    loopSteps.push({
      id: `loop.${id}`,
      order: loopSteps.length + 1,
      playerAction,
      gameResponse,
      reward,
      risk,
      confidence: "inferred",
      evidenceRefs,
    });
  };
  if (systems.has("player") || systems.has("weapon")) {
    addStep(
      "engage",
      systems.has("weapon") ? "移动、瞄准并使用武器" : "控制角色移动并观察环境",
      systems.has("weapon") ? "游戏计算射击、命中和弹药状态" : "游戏更新角色位置与场景状态",
      "取得更有利的位置或削弱敌人",
      "暴露在敌人攻击范围内",
      [systems.get("player")?.evidenceId, systems.get("weapon")?.evidenceId].filter(Boolean),
    );
  }
  if (systems.has("enemy")) {
    addStep(
      "survive",
      "观察敌人并规避攻击",
      "敌人追踪、攻击或被玩家击败",
      "继续生存并清除当前威胁",
      "受到伤害或失去战斗空间",
      [systems.get("enemy").evidenceId],
    );
  }
  if (systems.has("mission") || systems.has("level")) {
    addStep(
      "advance",
      "完成当前交战目标",
      "任务系统推进波次、关卡或结算状态",
      "解锁下一阶段内容",
      "失败条件可能结束本轮游戏",
      [systems.get("mission")?.evidenceId, systems.get("level")?.evidenceId].filter(Boolean),
    );
  }
  if (systems.has("boss")) {
    addStep(
      "boss",
      "针对首领弱点持续输出并躲避高威胁攻击",
      "首领进入不同攻击状态直至被摧毁",
      "完成关键战斗目标",
      "高伤害攻击会快速结束本轮游戏",
      [systems.get("boss").evidenceId],
    );
  }

  const rules = [];
  for (const source of sources) {
    const handlerPattern = /(\w+)\.on\(\s*["']([^"']+)["']\s*,/g;
    for (const match of source.text.matchAll(handlerPattern)) {
      const [trigger, result] = EVENT_RULES[match[2]] ?? [];
      if (!trigger || rules.length >= 12) continue;
      const owner = stablePart(match[1]);
      const id = `rule.${owner}-${stablePart(match[2])}`;
      if (rules.some((rule) => rule.id === id)) continue;
      const handlerPreview = source.text.slice(match.index ?? 0, (match.index ?? 0) + 500);
      const feedbackChannels = [
        /hud\./i.test(handlerPreview) ? "HUD" : null,
        /audio\./i.test(handlerPreview) ? "音效" : null,
        /particles?\./i.test(handlerPreview) ? "粒子特效" : null,
        /postFX\./i.test(handlerPreview) ? "画面后处理" : null,
      ].filter(Boolean);
      const evidenceId = evidence.add(`evidence.event-${owner}-${stablePart(match[2])}`, {
        kind: "source-code",
        file: source.relativePath,
        symbol: `${match[1]}.on('${match[2]}')`,
        details: `${source.relativePath} registers and consumes the ${match[2]} event.`,
        confidence: "confirmed",
      });
      rules.push({
        id,
        ownerId: `system.${owner}`,
        label: `${trigger} → ${result}`,
        trigger,
        condition: "对应运行时事件已触发",
        result,
        playerFeedback: feedbackChannels.length > 0 ? `${feedbackChannels.join("、")}提供结果反馈` : "未识别到明确反馈通道",
        runtimeStatus: "consumed",
        confidence: "confirmed",
        evidenceRefs: [evidenceId],
        sourceBindings: [{
          file: source.relativePath,
          symbol: `${match[1]}.on('${match[2]}')`,
          lineHint: lineNumberAt(source.text, match.index ?? 0),
          access: "read-only",
        }],
      });
    }
  }

  const summaryParts = [];
  if (systems.has("weapon")) summaryParts.push("移动、瞄准并射击");
  else if (systems.has("player")) summaryParts.push("控制角色探索场景");
  if (systems.has("enemy")) summaryParts.push("对抗敌人并保持生存");
  if (systems.has("mission") || systems.has("level")) summaryParts.push("完成目标并推进下一阶段");
  if (systems.has("boss")) summaryParts.push("最终击败首领");
  return {
    summary: summaryParts.length > 0 ? `${summaryParts.join("，")}。` : "尚未从源码识别出可信的核心玩法循环。",
    loopSteps,
    rules,
  };
}

function proceduralAssetDefinitions() {
  return [
    [/\/World\.[^.]+$/i, "world", "程序化港区场景", "environment"],
    [/\/CityWorld\.[^.]+$/i, "city-world", "程序化城市场景", "environment"],
    [/\/EnemyFactory\.[^.]+$/i, "enemy-model", "程序化敌人模型", "enemy"],
    [/\/WeaponViewModel\.[^.]+$/i, "weapon-view", "第一人称武器模型", "player"],
    [/\/Particles\.[^.]+$/i, "particles", "战斗粒子特效", "effect"],
    [/\/AudioEngine\.[^.]+$/i, "audio", "程序化音频反馈", "audio"],
  ];
}

function analyzeAssets(projectRoot, allFiles, sources, evidence) {
  const assets = [];
  const ids = new Set();
  const addAsset = (asset) => {
    if (ids.has(asset.id)) return;
    ids.add(asset.id);
    assets.push(asset);
  };

  for (const absolutePath of allFiles) {
    const extension = extname(absolutePath).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension)) continue;
    const relativePath = toPosix(relative(projectRoot, absolutePath));
    const id = `asset.file-${stablePart(relativePath)}`;
    const usageSites = sources
      .filter((source) => source.text.includes(basename(relativePath)))
      .slice(0, 5)
      .map((source) => ({ file: source.relativePath, access: "read-only" }));
    const isRuntimeAssetDirectory = /^(public|assets|src\/assets)\//.test(relativePath);
    if (!isRuntimeAssetDirectory && usageSites.length === 0) continue;
    const evidenceId = evidence.add(`evidence.asset-file-${stablePart(relativePath)}`, {
      kind: "asset",
      file: relativePath,
      details: `${relativePath} is a project asset file.`,
      confidence: "confirmed",
    });
    const technicalContract = {
      kind: [".glb", ".gltf"].includes(extension) ? "model" : [".mp3", ".wav", ".ogg"].includes(extension) ? "audio" : "image",
      acceptedMimeTypes: [mimeTypeForExtension(extension)],
    };
    if ([".glb", ".gltf"].includes(extension)) technicalContract.modelFormats = [extension.slice(1)];
    addAsset({
      id,
      slot: `file.${stablePart(relativePath)}`,
      category: assetCategory(relativePath),
      label: basename(relativePath),
      source: { file: relativePath, access: "editable" },
      preview: relativePath,
      usageSites,
      technicalContract,
      replacementPolicy: { preserveGameplayBindings: true, requiresValidation: true },
      confidence: "confirmed",
      evidenceRefs: [evidenceId],
    });
  }

  for (const [pattern, slug, label, category] of proceduralAssetDefinitions()) {
    const source = sources.find((candidate) => pattern.test(`/${candidate.relativePath}`));
    if (!source) continue;
    const evidenceId = evidence.add(`evidence.asset-procedural-${slug}`, {
      kind: "source-code",
      file: source.relativePath,
      details: `${source.relativePath} constructs ${label} at runtime instead of loading an external asset.`,
      confidence: "confirmed",
    });
    const usageSites = sources
      .filter((candidate) => candidate.relativePath !== source.relativePath && candidate.text.includes(basename(source.relativePath)))
      .slice(0, 5)
      .map((candidate) => ({ file: candidate.relativePath, access: "read-only" }));
    addAsset({
      id: `asset.procedural-${slug}`,
      slot: `procedural.${slug}`,
      category,
      label,
      source: { file: source.relativePath, access: "read-only" },
      preview: null,
      usageSites,
      technicalContract: { kind: "generated-runtime", acceptedMimeTypes: [] },
      replacementPolicy: { preserveGameplayBindings: true, requiresValidation: true },
      confidence: "confirmed",
      evidenceRefs: [evidenceId],
    });
  }
  return assets;
}

async function buildWorldview(projectRoot, packageJson, allFiles, sources, assets, evidence) {
  const indexPath = allFiles.find((path) => toPosix(relative(projectRoot, path)) === "index.html");
  const indexHtml = indexPath ? await readFile(indexPath, "utf8") : null;
  const title = extractDocumentTitle(indexHtml) ?? packageJson?.name ?? basename(projectRoot);
  const objectives = extractObjectiveStrings(sources);
  const source = objectives[0]?.source ?? sources.find((item) => item.relativePath.endsWith("main.js")) ?? sources[0];
  const details = objectives.length > 0
    ? `The title and objective strings suggest the game's setting and conflict: ${objectives.map((item) => item.text).join(" / ")}.`
    : `The project title ${title} is the only available narrative signal.`;
  const evidenceId = evidence.add("evidence.worldview-inference", {
    kind: "inference",
    ...(source ? { file: source.relativePath } : {}),
    details,
    confidence: "inferred",
  });
  const assetIds = assets.slice(0, 6).map((asset) => asset.id);
  return {
    cards: [{
      id: "world.setting",
      category: "setting",
      title,
      body: objectives.length > 0
        ? `从任务文本推断，玩家需要完成：${objectives.map((item) => item.text).join("、")}。具体世界设定仍需用户确认。`
        : "项目尚未提供足够的世界观文本，需要用户补充。",
      confidence: "inferred",
      evidenceRefs: [evidenceId],
      sourceBindings: source ? [{ file: source.relativePath, access: "read-only" }] : [],
      editableFields: ["title", "body", "assetIds"],
      assetIds,
    }],
  };
}

function buildDependencies(worldview, assets) {
  const dependencies = [];
  const assetIds = new Set(assets.map((asset) => asset.id));
  for (const card of worldview.cards) {
    for (const assetId of card.assetIds) {
      if (!assetIds.has(assetId)) continue;
      dependencies.push({
        from: card.id,
        to: assetId,
        relation: "presents",
        rationale: "The asset is presented as visual context for this worldview card.",
      });
    }
  }
  return dependencies;
}

function computeCoverage({ worldview, coreGameplay, tuningParameters, assets, entryPoints, runtimeRoots }) {
  const worldviewStatus = worldview.cards.some((card) => card.confidence === "confirmed")
    ? "full"
    : worldview.cards.length > 0 ? "partial" : "missing";
  const coreLoopStatus = coreGameplay.loopSteps.some((step) => step.confidence === "confirmed")
    ? "full"
    : coreGameplay.loopSteps.length > 0 ? "partial" : "missing";
  const assetStatus = assets.some((asset) => asset.technicalContract.kind !== "generated-runtime" && asset.source.access === "editable")
    ? "full"
    : assets.length > 0 ? "partial" : "missing";
  const checks = [
    ["three-engine", "full", 20],
    ["entry-point", entryPoints.length > 0 ? "full" : "missing", 10],
    ["runtime-roots", runtimeRoots.length > 0 ? "full" : "missing", 10],
    ["worldview", worldviewStatus, 10],
    ["core-loop", coreLoopStatus, 15],
    ["runtime-rules", coreGameplay.rules.length > 0 ? "full" : "missing", 10],
    ["tuning-parameters", tuningParameters.length > 0 ? "full" : "missing", 15],
    ["asset-slots", assetStatus, 10],
  ].map(([id, status, weight]) => ({
    id,
    status,
    weight,
    earned: status === "full" ? weight : status === "partial" ? weight / 2 : 0,
  }));
  const score = checks.reduce((total, check) => total + check.earned, 0);
  return { score, checks };
}

export async function analyzeThreeProject(rawProjectRoot, options = {}) {
  const projectRoot = resolve(rawProjectRoot);
  const maxFiles = options.maxFiles ?? 2500;
  const allFiles = await walkProject(projectRoot, maxFiles);
  const sources = await loadSources(projectRoot, allFiles);
  const packageJson = await loadPackage(projectRoot);
  if (!detectsThree(packageJson, sources)) {
    throw new UnsupportedThreeProjectError("No direct Three.js dependency or source import was found.");
  }

  const evidence = createEvidenceRegistry();
  const entryPoints = await detectEntryPoints(projectRoot, allFiles, sources);
  const runtimeRoots = detectRuntimeRoots(sources);
  const threeEvidence = evidence.add("evidence.three-runtime", {
    kind: packageJson?.dependencies?.three || packageJson?.devDependencies?.three ? "configuration" : "source-code",
    file: packageJson ? "package.json" : entryPoints[0],
    details: `The project declares or imports Three.js${detectThreeVersion(packageJson) ? ` ${detectThreeVersion(packageJson)}` : ""}.`,
    confidence: "confirmed",
  });
  void threeEvidence;

  const limitations = [];
  if (allFiles.length >= maxFiles) limitations.push(`扫描达到 ${maxFiles} 个文件上限，结果可能不完整。`);
  if (entryPoints.length === 0) limitations.push("未可靠识别浏览器入口文件。" );

  const assets = analyzeAssets(projectRoot, allFiles, sources, evidence);
  if (assets.length === 0) limitations.push("未发现外部或已知程序化素材入口。" );
  if (assets.every((asset) => asset.technicalContract.kind === "generated-runtime")) {
    limitations.push("当前素材均由运行时代码生成，尚不能直接交给第三方素材 Provider 替换。" );
  }
  const worldview = await buildWorldview(projectRoot, packageJson, allFiles, sources, assets, evidence);
  if (worldview.cards.length > 0 && worldview.cards.every((card) => card.confidence !== "confirmed")) {
    limitations.push("世界观来自标题与任务文本推断，尚未得到用户确认。" );
  }
  const systems = detectSystems(sources, evidence);
  const coreGameplay = buildCoreGameplay(sources, systems, evidence);
  if (coreGameplay.loopSteps.length === 0) limitations.push("未识别出可信的核心玩法循环。" );
  else if (coreGameplay.loopSteps.every((step) => step.confidence !== "confirmed")) {
    limitations.push("核心玩法循环由系统结构推断，仍需通过实际试玩确认顺序与玩家感受。" );
  }
  const tuningAnalysis = analyzeTuning(sources, reachableRuntimeSources(sources, entryPoints), evidence, limitations);

  const coverage = computeCoverage({
    worldview,
    coreGameplay,
    tuningParameters: tuningAnalysis.parameters,
    assets,
    entryPoints,
    runtimeRoots,
  });
  const projectName = packageJson?.name ?? basename(projectRoot);
  const model = {
    schemaVersion: "0.1.0",
    modelId: `project.${stablePart(projectName)}`,
    generatedAt: new Date().toISOString(),
    project: {
      name: projectName,
      root: projectRoot,
      engine: "three",
      detectedThreeVersion: detectThreeVersion(packageJson),
      entryPoints,
      runtimeRoots,
      coverage: coverage.score / 100,
      limitations,
    },
    evidence: evidence.items,
    worldview,
    coreGameplay,
    tuningParameters: tuningAnalysis.parameters,
    assets,
    dependencies: buildDependencies(worldview, assets),
  };
  return {
    model,
    analysis: {
      scannedFiles: allFiles.length,
      sourceFiles: sources.length,
      tuningAdapter: tuningAnalysis.adapter,
      tuningSource: tuningAnalysis.source,
      skippedTuningFields: tuningAnalysis.skippedFields,
      coverage,
    },
  };
}

export function renderCoverageReport(result) {
  const { model, analysis } = result;
  const confirmed = model.evidence.filter((item) => item.confidence === "confirmed").length;
  const inferred = model.evidence.filter((item) => item.confidence === "inferred").length;
  const rows = analysis.coverage.checks
    .map((check) => `| ${check.id} | ${{ full: "已覆盖", partial: "部分覆盖", missing: "缺失" }[check.status]} | ${check.earned}/${check.weight} |`)
    .join("\n");
  const limitations = model.project.limitations.length > 0
    ? model.project.limitations.map((item) => `- ${item}`).join("\n")
    : "- 无";
  return `# Three.js 游戏分析覆盖率\n\n`
    + `- 项目：${model.project.name}\n`
    + `- Three.js：${model.project.detectedThreeVersion ?? "版本未知"}\n`
    + `- 总覆盖率：${Math.round(model.project.coverage * 100)}%\n`
    + `- 扫描文件：${analysis.scannedFiles}（源码 ${analysis.sourceFiles}）\n`
    + `- 调优适配器：${analysis.tuningAdapter}\n`
    + `- 已确认证据：${confirmed}\n`
    + `- 推断证据：${inferred}\n`
    + `- 核心循环步骤：${model.coreGameplay.loopSteps.length}\n`
    + `- 已消费玩法规则：${model.coreGameplay.rules.length}\n`
    + `- 可调参数：${model.tuningParameters.length}\n`
    + `- 素材槽位：${model.assets.length}\n\n`
    + `## 覆盖项\n\n| 项目 | 状态 | 得分 |\n| --- | --- | ---: |\n${rows}\n\n`
    + `## 限制\n\n${limitations}\n\n`
    + `## 边界说明\n\n`
    + `世界观与核心循环允许标记为推断；只有同时找到显式配置声明和运行时消费者的数值，才会成为可调参数。分析器不会执行目标项目源码。\n`;
}

function parseCli(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = argv[++index];
    else if (argument === "--report") options.report = argv[++index];
    else if (argument === "--max-files") options.maxFiles = Number(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  return { projectRoot: positional[0], ...options };
}

function helpText() {
  return `Usage: node scripts/analyze-three-project.mjs <project-root> [options]\n\n`
    + `Options:\n`
    + `  --output <path>     Write GameTuningModel JSON. Otherwise print JSON to stdout.\n`
    + `  --report <path>     Write a Markdown coverage report.\n`
    + `  --max-files <n>     Limit scanned files (default: 2500).\n`
    + `  -h, --help          Show this help.\n`;
}

async function writeOutput(path, content) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  if (args.help || !args.projectRoot) {
    console.log(helpText());
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  try {
    const result = await analyzeThreeProject(args.projectRoot, { maxFiles: args.maxFiles });
    const modelText = `${JSON.stringify(result.model, null, 2)}\n`;
    const reportText = renderCoverageReport(result);
    const written = [];
    if (args.output) written.push(`model: ${await writeOutput(args.output, modelText)}`);
    else process.stdout.write(modelText);
    if (args.report) written.push(`report: ${await writeOutput(args.report, reportText)}`);
    if (written.length > 0) console.error(`Three.js analysis complete\n${written.join("\n")}`);
  } catch (error) {
    console.error(`Three.js analysis failed: ${error.message}`);
    process.exitCode = error instanceof UnsupportedThreeProjectError ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
