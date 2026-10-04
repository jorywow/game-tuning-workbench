import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { normalizeDraftValue } from "../assets/workbench/draft-model.js";

const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const NUMERIC_LITERAL = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";

function assert(condition, message, code = "INVALID_CHANGESET") {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeHistoryName(file) {
  return Buffer.from(file).toString("base64url");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nearestObjectGroup(lines, targetIndex) {
  const pattern = /^\s*([A-Za-z_$][\w$]*)\s*:\s*Object\.freeze\(\{\s*$/;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const match = lines[index].match(pattern);
    if (match) return { name: match[1], index };
  }
  return null;
}

export function patchNumericBinding(source, binding, before, after) {
  assert(binding?.access === "editable", "Source binding is not editable.");
  assert(Number.isInteger(binding.lineHint) && binding.lineHint > 0, "Numeric source edits require an exact lineHint.");
  assert(typeof binding.symbol === "string", "Numeric source edits require a symbol.");
  assert(Number.isFinite(before) && Number.isFinite(after), "Only finite numeric values can be applied.");

  const parts = binding.symbol.split(".");
  assert(parts.length >= 1 && parts.length <= 3, `Unsupported symbol shape: ${binding.symbol}. Expected ROOT, ROOT.field or ROOT.group.field.`);
  const [rootName, groupName, fieldName] = parts.length === 3 ? parts : [parts[0], null, parts[1]];
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const targetIndex = binding.lineHint - 1;
  assert(targetIndex < lines.length, `${binding.file}:${binding.lineHint} is outside the file.`, "SOURCE_DRIFT");

  if (parts.length === 1) {
    const constantPattern = new RegExp(`^(\\s*(?:export\\s+)?const\\s+${escapeRegExp(rootName)}\\s*=\\s*)(${NUMERIC_LITERAL})(\\s*;?\\s*(?:\\/\\/.*)?)$`);
    const match = lines[targetIndex].match(constantPattern);
    assert(match, `Expected numeric constant ${rootName} at ${binding.file}:${binding.lineHint}.`, "SOURCE_DRIFT");
    assert(Number(match[2]) === before, `Source drift for ${binding.symbol}: expected ${before}, found ${match[2]}.`, "SOURCE_DRIFT");
    lines[targetIndex] = `${match[1]}${JSON.stringify(after)}${match[3]}`;
    return lines.join(eol);
  }

  const rootPattern = new RegExp(`^\\s*(?:export\\s+)?const\\s+${escapeRegExp(rootName)}\\s*=\\s*(?:Object\\.freeze\\()?\\{\\s*$`);
  const rootIndex = lines.findIndex((line) => rootPattern.test(line));
  assert(rootIndex >= 0 && rootIndex < targetIndex, `Cannot confirm root object ${rootName}.`, "SOURCE_DRIFT");
  if (groupName) {
    const group = nearestObjectGroup(lines, targetIndex);
    assert(group?.name === groupName && group.index > rootIndex, `Expected ${groupName} group near ${binding.file}:${binding.lineHint}.`, "SOURCE_DRIFT");
  } else {
    const body = lines.slice(rootIndex + 1, targetIndex);
    assert(body.every((line) => !/^\s*}\)?\s*;?\s*$/.test(line)), `Expected ${fieldName} inside ${rootName}.`, "SOURCE_DRIFT");
    assert(body.every((line) => !/^\s*[A-Za-z_$][\w$]*\s*:\s*(?:Object\.freeze\()?\s*\{/.test(line)), `Nested object is not a flat numeric binding.`, "SOURCE_DRIFT");
  }

  const fieldPattern = new RegExp(`^(\\s*${escapeRegExp(fieldName)}\\s*:\\s*)(${NUMERIC_LITERAL})(\\s*,?.*)$`);
  const match = lines[targetIndex].match(fieldPattern);
  assert(match, `Expected numeric field ${fieldName} at ${binding.file}:${binding.lineHint}.`, "SOURCE_DRIFT");
  assert(Number(match[2]) === before, `Source drift for ${binding.symbol}: expected ${before}, found ${match[2]}.`, "SOURCE_DRIFT");
  lines[targetIndex] = `${match[1]}${JSON.stringify(after)}${match[3]}`;
  return lines.join(eol);
}

export function validateProposedChangeSet(model, candidate) {
  assert(candidate?.schemaVersion === "0.2.0", "Unsupported ChangeSet schema version.");
  assert(candidate.modelId === model.modelId, "ChangeSet modelId does not match this workbench.");
  assert(candidate.state === "proposed", "ChangeSet must be proposed before confirmation.");
  assert(Array.isArray(candidate.operations) && candidate.operations.length > 0, "ChangeSet needs at least one operation.");
  assert(candidate.confirmation?.required === true && candidate.confirmation.confirmedAt === null, "ChangeSet must still require confirmation.");
  assert(Array.isArray(candidate.impact?.excludedEffects) && candidate.impact.excludedEffects.length > 0, "ChangeSet must declare excluded effects.");

  const parameterById = new Map(model.tuningParameters.map((parameter) => [parameter.id, parameter]));
  const seenTargets = new Set();
  for (const operation of candidate.operations) {
    assert(STABLE_ID.test(operation.operationId ?? ""), "Operation ID is invalid.");
    assert(operation.application?.strategy === "automatic", "Codex-assisted operations cannot enter the local application engine.");
    assert(operation.application?.executor === "local-apply-engine", "Automatic operations must target the local application engine.");
    assert(operation.type === "set-parameter", "This application layer only supports set-parameter operations.");
    assert(!seenTargets.has(operation.targetId), `Duplicate target ${operation.targetId}.`);
    seenTargets.add(operation.targetId);
    const parameter = parameterById.get(operation.targetId);
    assert(parameter, `Unknown tuning target ${operation.targetId}.`);
    assert(parameter.confidence === "confirmed", `${operation.targetId} is not confirmed.`);
    assert(sameJson(operation.sourceBinding, parameter.sourceBinding), `${operation.targetId} source binding does not match the model.`);
    assert(sameJson(operation.before, parameter.currentValue), `${operation.targetId} before-value does not match the model.`);
    const normalized = normalizeDraftValue(parameter, operation.after);
    assert(normalized !== null && normalized === operation.after, `${operation.targetId} after-value is outside its safe range or step.`);
    assert(operation.after !== operation.before, `${operation.targetId} does not change its value.`);
  }
  return structuredClone(candidate);
}

async function resolveBoundFile(projectRoot, binding) {
  const candidate = resolve(projectRoot, binding.file);
  assert(isInside(projectRoot, candidate), `Source path escapes the approved project: ${binding.file}.`, "UNSAFE_PATH");
  const actual = await realpath(candidate);
  assert(isInside(projectRoot, actual), `Source file resolves outside the approved project: ${binding.file}.`, "UNSAFE_PATH");
  const fileStats = await stat(actual);
  assert(fileStats.isFile(), `${binding.file} is not a file.`, "UNSAFE_PATH");
  return { actual, mode: fileStats.mode, relativePath: relative(projectRoot, actual) };
}

async function preparePatches(projectRoot, operations, reverse = false) {
  const grouped = new Map();
  for (const operation of operations) {
    const file = await resolveBoundFile(projectRoot, operation.sourceBinding);
    const group = grouped.get(file.actual) ?? { ...file, operations: [] };
    group.operations.push(operation);
    grouped.set(file.actual, group);
  }

  const patches = [];
  for (const file of grouped.values()) {
    const original = await readFile(file.actual, "utf8");
    let next = original;
    for (const operation of file.operations) {
      next = patchNumericBinding(
        next,
        operation.sourceBinding,
        reverse ? operation.after : operation.before,
        reverse ? operation.before : operation.after,
      );
    }
    patches.push({ ...file, original, next });
  }
  return patches;
}

async function replaceFileAtomically(filePath, contents, mode) {
  const temporary = join(dirname(filePath), `.${basename(filePath)}.gtw-${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, filePath);
}

async function commitPatches(patches) {
  const committed = [];
  try {
    for (const patch of patches) {
      await replaceFileAtomically(patch.actual, patch.next, patch.mode);
      committed.push(patch);
    }
  } catch (error) {
    for (const patch of committed.reverse()) {
      try { await replaceFileAtomically(patch.actual, patch.original, patch.mode); } catch { /* Surface the original write failure. */ }
    }
    throw error;
  }
}

async function detectBuildCommand(projectRoot) {
  try {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    if (!packageJson.scripts?.build) return null;
    const candidates = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"],
    ];
    for (const [lockfile, command] of candidates) {
      try { await access(join(projectRoot, lockfile)); return { command, args: ["run", "build"] }; } catch { /* Try the next lockfile. */ }
    }
    return { command: "npm", args: ["run", "build"] };
  } catch {
    return null;
  }
}

async function runBuildVerification(projectRoot, enabled) {
  if (!enabled) return { status: "not-run", command: null, output: "Build verification disabled for this service." };
  const detected = await detectBuildCommand(projectRoot);
  if (!detected) return { status: "not-run", command: null, output: "No build script detected." };
  return new Promise((resolvePromise) => {
    const child = spawn(detected.command, detected.args, { cwd: projectRoot, env: process.env, shell: false });
    let output = "";
    const append = (chunk) => { output = `${output}${chunk}`.slice(-100_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: "failed", command: `${detected.command} ${detected.args.join(" ")}`, output: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        status: code === 0 ? "passed" : "failed",
        command: `${detected.command} ${detected.args.join(" ")}`,
        output: signal ? `${output}\nTerminated by ${signal}` : output,
      });
    });
  });
}

async function writeReceipt(historyRoot, receipt) {
  const receiptRoot = join(historyRoot, receipt.receiptId);
  await mkdir(receiptRoot, { recursive: true });
  await writeFile(join(receiptRoot, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receiptRoot;
}

function createPlaytestChecklist(changeSet, model) {
  const parameterById = new Map(model.tuningParameters.map((parameter) => [parameter.id, parameter]));
  const checks = [];
  let index = 0;
  for (const operation of changeSet.operations) {
    const parameter = parameterById.get(operation.targetId);
    const directEffects = parameter?.effects?.direct?.length ? parameter.effects.direct : [operation.reason];
    for (const effect of directEffects) {
      index += 1;
      checks.push({
        checkId: `check.expected.${index}`,
        kind: "expected-effect",
        targetId: operation.targetId,
        label: `确认「${parameter?.label ?? operation.targetId}」的变化`,
        description: effect,
        status: "not-run",
        notes: "",
      });
    }
  }
  for (const effect of changeSet.impact.excludedEffects) {
    index += 1;
    checks.push({
      checkId: `check.excluded.${index}`,
      kind: "excluded-effect",
      targetId: null,
      label: "确认未产生连带影响",
      description: effect,
      status: "not-run",
      notes: "",
    });
  }
  return checks;
}

function normalizePlaytest(receipt, model) {
  if (receipt.playtest) return receipt.playtest;
  return {
    status: "not-run",
    checks: createPlaytestChecklist(receipt.changeSet, model),
    evidence: [],
    notes: "",
    updatedAt: null,
  };
}

function assertReceiptId(receiptId) {
  assert(STABLE_ID.test(receiptId ?? "") && receiptId.startsWith("receipt."), "Receipt ID is invalid.", "INVALID_RECEIPT");
}

export class ApplyService {
  constructor({ model, projectRoot, workbenchRoot, verifyBuild = true, writeEnabled = true }) {
    this.model = model;
    this.projectRoot = projectRoot;
    this.workbenchRoot = workbenchRoot;
    this.historyRoot = join(workbenchRoot, ".gtw-history");
    this.verifyBuild = verifyBuild;
    this.writeEnabled = writeEnabled;
    this.proposals = new Map();
  }

  async initialize() {
    this.projectRoot = await realpath(this.projectRoot);
    const modelRoot = await realpath(this.model.project.root);
    assert(modelRoot === this.projectRoot, "Approved project root does not match the analyzed model root.", "PROJECT_ROOT_MISMATCH");
    if (this.writeEnabled) await mkdir(this.historyRoot, { recursive: true });
    return this;
  }

  async updateModelSnapshot(operations, reverse = false) {
    const nextModel = structuredClone(this.model);
    const parameterById = new Map(nextModel.tuningParameters.map((parameter) => [parameter.id, parameter]));
    for (const operation of operations) {
      const parameter = parameterById.get(operation.targetId);
      assert(parameter, `Model snapshot lost target ${operation.targetId}.`);
      parameter.currentValue = reverse ? operation.before : operation.after;
    }
    const modelPath = join(this.workbenchRoot, "game-tuning-model.json");
    const modelStats = await stat(modelPath);
    await replaceFileAtomically(modelPath, `${JSON.stringify(nextModel, null, 2)}\n`, modelStats.mode);
    this.model = nextModel;
  }

  async readReceipt(receiptId) {
    assertReceiptId(receiptId);
    const receiptPath = join(this.historyRoot, receiptId, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert(receipt.projectRoot === this.projectRoot, "Receipt belongs to a different project.", "INVALID_RECEIPT");
    receipt.playtest = normalizePlaytest(receipt, this.model);
    return receipt;
  }

  async listReceipts() {
    let entries = [];
    try {
      entries = await readdir(this.historyRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const receipts = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("receipt.")) continue;
      try { receipts.push(await this.readReceipt(entry.name)); } catch { /* Ignore incomplete or foreign records. */ }
    }
    return receipts.sort((left, right) => String(right.appliedAt ?? "").localeCompare(String(left.appliedAt ?? "")));
  }

  async propose(candidate) {
    const changeSet = validateProposedChangeSet(this.model, candidate);
    await preparePatches(this.projectRoot, changeSet.operations);
    const proposalId = `proposal.${randomUUID().replaceAll("-", "")}`;
    const digest = hash(JSON.stringify(changeSet));
    this.proposals.set(proposalId, { changeSet, digest, createdAt: Date.now() });
    return {
      proposalId,
      digest,
      operationCount: changeSet.operations.length,
      fileCount: new Set(changeSet.operations.map((operation) => operation.sourceBinding.file)).size,
      projectName: this.model.project.name,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  async apply({ proposalId, digest, confirmed }) {
    assert(this.writeEnabled, "Source-write service is not enabled.", "APPLY_DISABLED");
    assert(confirmed === true, "Explicit confirmation is required.", "CONFIRMATION_REQUIRED");
    const proposal = this.proposals.get(proposalId);
    assert(proposal, "Proposal is missing or expired.", "PROPOSAL_NOT_FOUND");
    assert(Date.now() - proposal.createdAt <= 15 * 60_000, "Proposal expired; create a new one.", "PROPOSAL_EXPIRED");
    assert(proposal.digest === digest, "Proposal digest does not match.", "PROPOSAL_CHANGED");

    const patches = await preparePatches(this.projectRoot, proposal.changeSet.operations);
    const receiptId = `receipt.${randomUUID().replaceAll("-", "")}`;
    const confirmedAt = new Date().toISOString();
    const receipt = {
      receiptId,
      projectRoot: this.projectRoot,
      state: "proposed",
      changeSet: { ...proposal.changeSet, state: "proposed" },
      appliedAt: null,
      revertedAt: null,
      files: patches.map((patch) => ({
        path: patch.relativePath,
        beforeHash: hash(patch.original),
        afterHash: hash(patch.next),
        backup: `originals/${safeHistoryName(patch.relativePath)}`,
      })),
      verification: { status: "not-run", command: null, output: "" },
      playtest: {
        status: "not-run",
        checks: createPlaytestChecklist(proposal.changeSet, this.model),
        evidence: [],
        notes: "",
        updatedAt: null,
      },
    };
    const receiptRoot = await writeReceipt(this.historyRoot, receipt);
    await mkdir(join(receiptRoot, "originals"), { recursive: true });
    for (const patch of patches) {
      await writeFile(join(receiptRoot, "originals", safeHistoryName(patch.relativePath)), patch.original, "utf8");
    }

    await commitPatches(patches);
    try {
      await this.updateModelSnapshot(proposal.changeSet.operations);
    } catch (error) {
      await commitPatches(patches.map((patch) => ({ ...patch, original: patch.next, next: patch.original })));
      throw error;
    }
    receipt.appliedAt = confirmedAt;
    receipt.changeSet.confirmation = { required: true, confirmedAt };
    receipt.changeSet.state = "applied";
    receipt.state = "applied";
    receipt.verification = await runBuildVerification(this.projectRoot, this.verifyBuild);
    if (receipt.verification.status === "failed") {
      receipt.state = "failed";
      receipt.changeSet.state = "failed";
      receipt.changeSet.verification.status = "failed";
    }
    await writeReceipt(this.historyRoot, receipt);
    this.proposals.delete(proposalId);
    return receipt;
  }

  async addEvidence(receiptId, { label, dataUrl }) {
    assert(this.writeEnabled, "Source-write service is not enabled.", "APPLY_DISABLED");
    const receipt = await this.readReceipt(receiptId);
    assert(new Set(["applied", "failed", "verified"]).has(receipt.state), `Receipt cannot accept evidence from ${receipt.state}.`, "INVALID_RECEIPT_STATE");
    assert(typeof label === "string" && label.trim().length > 0 && label.length <= 120, "Screenshot label is required and must be at most 120 characters.");
    const match = String(dataUrl ?? "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    assert(match, "Screenshot must be a PNG, JPEG, or WebP data URL.", "INVALID_EVIDENCE");
    const contents = Buffer.from(match[2], "base64");
    assert(contents.length > 0 && contents.length <= 8 * 1024 * 1024, "Screenshot must be between 1 byte and 8 MB.", "INVALID_EVIDENCE");
    const evidenceId = `evidence.${randomUUID().replaceAll("-", "")}`;
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const evidenceRoot = join(this.historyRoot, receiptId, "evidence");
    await mkdir(evidenceRoot, { recursive: true });
    const fileName = `${evidenceId}.${extension}`;
    await writeFile(join(evidenceRoot, fileName), contents);
    const evidence = {
      evidenceId,
      type: "screenshot",
      label: label.trim(),
      mimeType: `image/${match[1]}`,
      fileName,
      capturedAt: new Date().toISOString(),
    };
    receipt.playtest.evidence.push(evidence);
    receipt.playtest.updatedAt = evidence.capturedAt;
    await writeReceipt(this.historyRoot, receipt);
    return receipt;
  }

  async getEvidence(receiptId, evidenceId) {
    const receipt = await this.readReceipt(receiptId);
    assert(STABLE_ID.test(evidenceId ?? "") && evidenceId.startsWith("evidence."), "Evidence ID is invalid.", "INVALID_EVIDENCE");
    const evidence = receipt.playtest.evidence.find((item) => item.evidenceId === evidenceId);
    assert(evidence, "Screenshot evidence was not found.", "INVALID_EVIDENCE");
    return {
      evidence,
      path: join(this.historyRoot, receiptId, "evidence", evidence.fileName),
    };
  }

  async deleteEvidence(receiptId, evidenceId) {
    assert(this.writeEnabled, "Source-write service is not enabled.", "APPLY_DISABLED");
    const receipt = await this.readReceipt(receiptId);
    const evidence = receipt.playtest.evidence.find((item) => item.evidenceId === evidenceId);
    assert(evidence, "Screenshot evidence was not found.", "INVALID_EVIDENCE");
    await unlink(join(this.historyRoot, receiptId, "evidence", evidence.fileName));
    receipt.playtest.evidence = receipt.playtest.evidence.filter((item) => item.evidenceId !== evidenceId);
    receipt.playtest.updatedAt = new Date().toISOString();
    if (receipt.state === "verified" && receipt.playtest.evidence.length === 0) {
      receipt.state = "applied";
      receipt.changeSet.state = "applied";
      receipt.playtest.status = "not-run";
      receipt.changeSet.verification.status = "not-run";
      receipt.changeSet.verification.evidence = [];
    }
    await writeReceipt(this.historyRoot, receipt);
    return receipt;
  }

  async updatePlaytest(receiptId, candidate) {
    assert(this.writeEnabled, "Source-write service is not enabled.", "APPLY_DISABLED");
    const receipt = await this.readReceipt(receiptId);
    assert(new Set(["applied", "failed", "verified"]).has(receipt.state), `Receipt cannot be verified from ${receipt.state}.`, "INVALID_RECEIPT_STATE");
    assert(Array.isArray(candidate?.checks), "Playtest checks are required.");
    const statusById = new Map(candidate.checks.map((check) => [check.checkId, check]));
    assert(statusById.size === receipt.playtest.checks.length, "Every playtest check must be included.");
    const nextChecks = receipt.playtest.checks.map((check) => {
      const update = statusById.get(check.checkId);
      assert(update && new Set(["not-run", "passed", "failed"]).has(update.status), `Invalid result for ${check.checkId}.`);
      return { ...check, status: update.status, notes: String(update.notes ?? "").slice(0, 1000) };
    });
    const status = candidate.status ?? "not-run";
    assert(new Set(["not-run", "passed", "failed"]).has(status), "Invalid playtest status.");
    if (status === "passed") {
      assert(receipt.verification.status !== "failed", "A failed build cannot be marked as verified.", "VERIFICATION_BLOCKED");
      assert(nextChecks.every((check) => check.status === "passed"), "All playtest checks must pass before verification.", "VERIFICATION_BLOCKED");
      assert(receipt.playtest.evidence.length > 0, "Add at least one screenshot before verification.", "VERIFICATION_BLOCKED");
    }
    if (status === "failed") {
      assert(nextChecks.some((check) => check.status === "failed"), "Mark at least one failed check.", "VERIFICATION_BLOCKED");
    }
    receipt.playtest = {
      ...receipt.playtest,
      status,
      checks: nextChecks,
      notes: String(candidate.notes ?? "").slice(0, 4000),
      updatedAt: new Date().toISOString(),
    };
    receipt.changeSet.verification = {
      status,
      checks: nextChecks.map((check) => ({
        type: "browser",
        description: `${check.label}：${check.description}`,
        status: check.status,
      })),
      evidence: receipt.playtest.evidence.map((evidence) => evidence.evidenceId),
    };
    if (status === "passed") {
      receipt.state = "verified";
      receipt.changeSet.state = "verified";
    } else if (status === "failed") {
      receipt.state = "failed";
      receipt.changeSet.state = "failed";
    } else if (receipt.state === "verified" || (receipt.state === "failed" && receipt.verification.status !== "failed")) {
      receipt.state = "applied";
      receipt.changeSet.state = "applied";
    }
    await writeReceipt(this.historyRoot, receipt);
    return receipt;
  }

  async revert(receiptId) {
    assert(this.writeEnabled, "Source-write service is not enabled.", "APPLY_DISABLED");
    const receipt = await this.readReceipt(receiptId);
    assert(new Set(["applied", "failed", "verified"]).has(receipt.state), `Receipt cannot be reverted from ${receipt.state}.`, "INVALID_RECEIPT_STATE");
    const patches = await preparePatches(this.projectRoot, receipt.changeSet.operations, true);
    await commitPatches(patches);
    try {
      await this.updateModelSnapshot(receipt.changeSet.operations, true);
    } catch (error) {
      await commitPatches(patches.map((patch) => ({ ...patch, original: patch.next, next: patch.original })));
      throw error;
    }
    receipt.state = "reverted";
    receipt.revertedAt = new Date().toISOString();
    receipt.changeSet.state = "reverted";
    receipt.changeSet.rollback.status = "passed";
    receipt.postRevertVerification = await runBuildVerification(this.projectRoot, this.verifyBuild);
    await writeReceipt(this.historyRoot, receipt);
    return receipt;
  }
}
