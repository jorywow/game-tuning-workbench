import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UnsupportedThreeProjectError,
  analyzeThreeProject,
  renderCoverageReport,
} from "../scripts/analyze-three-project.mjs";

async function createProject(files) {
  const root = await mkdtemp(join(tmpdir(), "game-tuning-analyzer-"));
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}

test("extracts only explicit tuning fields with runtime consumers", async (context) => {
  const projectRoot = await createProject({
    "package.json": JSON.stringify({
      name: "fixture-three-game",
      dependencies: { three: "^0.180.0" },
    }),
    "index.html": "<title>Fixture Arena</title><script type=\"module\" src=\"/src/main.js\"></script>",
    "src/main.js": "import * as THREE from 'three'; import { WeaponSystem } from './game/WeaponSystem.js'; const weapon = new WeaponSystem(); void THREE; void weapon; const state = { objective: '清除训练场敌人' }; void state;",
    "src/game/WeaponSystem.js": "export class WeaponSystem { constructor(config = {}) { this.config = config; } hit() { return this.config.damage; } }",
    "src/game/GameTuningConfig.js": `
      export const DEFAULT_TUNING = Object.freeze({
        weapon: Object.freeze({
          damage: 40,
          unusedValue: 3,
        }),
      });
      export const TUNING_SCHEMA = Object.freeze([
        { fields: [
          ['weapon.damage', '单发伤害', 5, 100, 1, '立即'],
          ['weapon.unusedValue', '未消费参数', 0, 10, 1, '立即'],
        ] },
      ]);
      export const TUNING_PRESETS = Object.freeze([]);
    `,
  });
  context.after(() => rm(projectRoot, { recursive: true, force: true }));

  const result = await analyzeThreeProject(projectRoot);
  assert.equal(result.model.project.engine, "three");
  assert.equal(result.model.project.detectedThreeVersion, "0.180.0");
  assert.deepEqual(result.model.project.entryPoints, ["src/main.js"]);
  assert.equal(result.analysis.tuningAdapter, "explicit-tuning-schema");
  assert.equal(result.model.tuningParameters.length, 1);
  assert.equal(result.model.tuningParameters[0].id, "tuning.weapon-damage");
  assert.equal(result.model.tuningParameters[0].currentValue, 40);
  assert.equal(result.model.tuningParameters[0].previewBinding.mode, "live");
  assert.deepEqual(result.analysis.skippedTuningFields, [
    { path: "weapon.unusedValue", reason: "missing-runtime-consumer" },
  ]);
  assert.match(renderCoverageReport(result), /总覆盖率/);
});

test("rejects projects without a Three.js dependency or import", async (context) => {
  const projectRoot = await createProject({
    "package.json": JSON.stringify({ name: "plain-site" }),
    "src/main.js": "document.body.textContent = 'hello';",
  });
  context.after(() => rm(projectRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => analyzeThreeProject(projectRoot),
    (error) => error instanceof UnsupportedThreeProjectError,
  );
});

test("discovers a consumed flat default config but ignores unreachable and unused values", async (context) => {
  const projectRoot = await createProject({
    "package.json": JSON.stringify({ name: "flight-fixture", dependencies: { three: "^0.180.0" } }),
    "index.html": '<script type="module" src="/src/main.js"></script>',
    "src/main.js": "import * as THREE from 'three'; import { FlightController } from './FlightController.js'; void THREE; new FlightController();",
    "src/FlightController.js": `const DEFAULTS = Object.freeze({
  forwardSpeed: 3.4,
  unusedDamage: 20,
});
export class FlightController {
  constructor() { this.config = { ...DEFAULTS }; }
  update(dt) { return this.config.forwardSpeed * dt; }
}`,
    "src/Unused.js": "const DEFAULTS = Object.freeze({\n  damage: 50,\n});\nexport const value = DEFAULTS.damage;",
  });
  context.after(() => rm(projectRoot, { recursive: true, force: true }));

  const result = await analyzeThreeProject(projectRoot);
  assert.equal(result.analysis.tuningAdapter, "conventional-config");
  assert.deepEqual(result.model.tuningParameters.map(p => p.sourceBinding.symbol), ["DEFAULTS.forwardSpeed"]);
  assert.equal(result.model.tuningParameters[0].sourceBinding.lineHint, 2);
  assert.equal(result.model.tuningParameters[0].previewBinding.mode, "restart-game");
});

test("leaves inline gameplay literals unavailable for automatic tuning", async (context) => {
  const projectRoot = await createProject({
    "package.json": JSON.stringify({ name: "inline-fixture", dependencies: { three: "^0.180.0" } }),
    "index.html": '<script type="module" src="/src/main.js"></script>',
    "src/main.js": "import * as THREE from 'three'; void THREE; const speed = 5; requestAnimationFrame(() => console.log(speed));",
  });
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const result = await analyzeThreeProject(projectRoot);
  assert.equal(result.model.tuningParameters.length, 0);
  assert.match(result.model.project.limitations.join(" "), /内联数字/);
});

test("discovers a named gameplay constant used by its runtime module", async (context) => {
  const projectRoot = await createProject({
    "package.json": JSON.stringify({ name: "combat-fixture", dependencies: { three: "^0.180.0" } }),
    "index.html": '<script type="module" src="/src/main.js"></script>',
    "src/main.js": "import * as THREE from 'three'; import { shoot } from './combat.js'; void THREE; shoot();",
    "src/combat.js": "export const MAGAZINE = 30;\nexport const RELOAD_SECONDS = 1.65;\nexport function shoot() { return MAGAZINE + RELOAD_SECONDS; }",
  });
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const result = await analyzeThreeProject(projectRoot);
  assert.deepEqual(result.model.tuningParameters.map(p => p.sourceBinding.symbol), ["MAGAZINE", "RELOAD_SECONDS"]);
});
