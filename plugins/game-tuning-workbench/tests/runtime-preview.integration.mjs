import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDraftChangeSet } from "../assets/workbench/draft-model.js";
import { RuntimePreviewService } from "../scripts/runtime-preview-service.mjs";

const projectRoot = await mkdtemp(join(tmpdir(), "gtw-runtime-project-"));
const sourcePath = join(projectRoot, "src", "GameTuningConfig.js");

const parameter = {
  id: "tuning.player-max-health",
  ownerId: "system.player",
  group: "controls",
  label: "最大生命",
  description: "玩家最大生命。",
  playerMeaning: { lower: "更脆弱", higher: "更耐打" },
  valueType: "integer",
  unit: null,
  currentValue: 100,
  defaultValue: 100,
  safeRange: { min: 50, max: 300, step: 5 },
  control: "slider",
  sourceBinding: { file: "src/GameTuningConfig.js", symbol: "DEFAULT_TUNING.player.maxHealth", lineHint: 3, access: "editable" },
  previewBinding: { consumer: "PlayerController.maxHealth", mode: "live" },
  effects: { direct: ["改变玩家最大生命"], indirect: [], excluded: ["不改变武器伤害"] },
  confidence: "confirmed",
  evidenceRefs: ["evidence.player-health"],
};

const model = {
  schemaVersion: "0.1.0",
  modelId: "project.runtime-preview-fixture",
  project: { name: "runtime-preview-fixture", root: projectRoot, engine: "three" },
  tuningParameters: [parameter],
  dependencies: [],
};

try {
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(sourcePath, "export const DEFAULT_TUNING = Object.freeze({\n  player: Object.freeze({\n    maxHealth: 100,\n  }),\n});\n", "utf8");
  await writeFile(join(projectRoot, "package.json"), `${JSON.stringify({
    name: "runtime-preview-fixture",
    private: true,
    type: "module",
    scripts: { dev: "node dev-server.mjs" },
  }, null, 2)}\n`, "utf8");
  await writeFile(join(projectRoot, "dev-server.mjs"), `
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const port = Number(value("--port", "4173"));
const host = value("--host", "127.0.0.1");
const source = await readFile(new URL("./src/GameTuningConfig.js", import.meta.url), "utf8");
const health = source.match(/maxHealth:\\s*(\\d+)/)?.[1] ?? "missing";
createServer((request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(\`<!doctype html><title>Fixture \${health}</title><main data-health="\${health}">Health \${health}</main>\`); }).listen(port, host);
`, "utf8");

  const changeSet = {
    ...buildDraftChangeSet(model, {
      [parameter.id]: { targetId: parameter.id, before: 100, after: 125 },
    }, "2026-09-01T00:00:00.000Z"),
    state: "proposed",
  };
  const service = await new RuntimePreviewService({ model, projectRoot }).initialize();
  const started = await service.start(changeSet);
  assert.equal(started.active, true);
  assert.equal(started.sourceUnchanged, true);
  assert.match(await fetch(started.session.baselineUrl).then((response) => response.text()), /Health 100/);
  assert.match(await fetch(started.session.draftUrl).then((response) => response.text()), /Health 125/);
  assert.match(await readFile(sourcePath, "utf8"), /maxHealth: 100/);
  const temporaryRoot = service.session.temporaryRoot;
  const stopped = await service.stop();
  assert.equal(stopped.active, false);
  assert.equal(stopped.sourceUnchanged, true);
  await assert.rejects(() => access(temporaryRoot));
  console.log("Runtime preview integration passed: baseline 100 -> draft 125 -> source unchanged -> temporary copies removed");
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}
