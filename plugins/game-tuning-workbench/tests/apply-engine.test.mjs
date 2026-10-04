import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDraftChangeSet, createWorldviewDraft } from "../assets/workbench/draft-model.js";
import { ApplyService, patchNumericBinding, validateProposedChangeSet } from "../scripts/apply-engine.mjs";
import { generateApplyWorkbench } from "../scripts/generate-apply-workbench.mjs";

function fixtureSource(maxHealth = 100) {
  return `export const DEFAULT_TUNING = Object.freeze({\n  player: Object.freeze({\n    maxHealth: ${maxHealth},\n    walkSpeed: 5.7,\n  }),\n});\n`;
}

function fixtureModel(projectRoot) {
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
    sourceBinding: {
      file: "src/game/GameTuningConfig.js",
      symbol: "DEFAULT_TUNING.player.maxHealth",
      lineHint: 3,
      access: "editable",
    },
    previewBinding: { consumer: "PlayerController.maxHealth", mode: "live" },
    effects: { direct: ["改变玩家最大生命"], indirect: [], excluded: ["不改变武器伤害"] },
    confidence: "confirmed",
    evidenceRefs: ["evidence.player-health"],
  };
  return {
    schemaVersion: "0.1.0",
    modelId: "project.apply-fixture",
    project: { name: "apply-fixture", root: projectRoot, engine: "three" },
    tuningParameters: [parameter],
    dependencies: [],
  };
}

function proposedChangeSet(model, after = 125) {
  return {
    ...buildDraftChangeSet(model, {
      "tuning.player-max-health": { targetId: "tuning.player-max-health", before: 100, after },
    }, "2026-08-31T00:00:00.000Z"),
    state: "proposed",
  };
}

async function createFixture(context, source = fixtureSource()) {
  const projectRoot = await mkdtemp(join(tmpdir(), "gtw-apply-project-"));
  const workbenchRoot = await mkdtemp(join(tmpdir(), "gtw-apply-workbench-"));
  context.after(() => Promise.all([
    rm(projectRoot, { recursive: true, force: true }),
    rm(workbenchRoot, { recursive: true, force: true }),
  ]));
  await mkdir(join(projectRoot, "src", "game"), { recursive: true });
  await writeFile(join(projectRoot, "src", "game", "GameTuningConfig.js"), source, "utf8");
  const model = fixtureModel(projectRoot);
  await writeFile(join(workbenchRoot, "game-tuning-model.json"), `${JSON.stringify(model, null, 2)}\n`, "utf8");
  const service = await new ApplyService({ model, projectRoot, workbenchRoot, verifyBuild: false }).initialize();
  return { projectRoot, workbenchRoot, model, service };
}

test("patches only the exact numeric binding and refuses drift", () => {
  const binding = fixtureModel("/tmp/project").tuningParameters[0].sourceBinding;
  const patched = patchNumericBinding(fixtureSource(), binding, 100, 125);
  assert.match(patched, /maxHealth: 125,/);
  assert.match(patched, /walkSpeed: 5\.7,/);
  assert.throws(() => patchNumericBinding(fixtureSource(110), binding, 100, 125), { code: "SOURCE_DRIFT" });
  assert.throws(() => patchNumericBinding(fixtureSource(), { ...binding, symbol: "DEFAULT_TUNING.enemy.maxHealth" }, 100, 125), { code: "SOURCE_DRIFT" });
});

test("patches a consumed flat default without changing adjacent values", () => {
  const original = "const DEFAULTS = Object.freeze({\n  forwardSpeed: 3.4,\n  dashSpeed: 11.5,\n});\n";
  const binding = { file: "src/FlightController.js", symbol: "DEFAULTS.forwardSpeed", lineHint: 2, access: "editable" };
  const updated = patchNumericBinding(original, binding, 3.4, 4.2);
  assert.match(updated, /forwardSpeed: 4\.2,/);
  assert.match(updated, /dashSpeed: 11\.5,/);
  assert.throws(() => patchNumericBinding(original, { ...binding, lineHint: 3 }, 3.4, 4.2), { code: "SOURCE_DRIFT" });
  assert.throws(() => patchNumericBinding(original, binding, 3.5, 4.2), { code: "SOURCE_DRIFT" });
});

test("patches an exact named gameplay constant and rejects drift", () => {
  const original = "export const MAGAZINE = 30;\nexport const RELOAD_SECONDS = 1.65;\n";
  const binding = { file: "src/combat.js", symbol: "MAGAZINE", lineHint: 1, access: "editable" };
  assert.match(patchNumericBinding(original, binding, 30, 36), /^export const MAGAZINE = 36;\nexport const RELOAD_SECONDS = 1\.65;/);
  assert.throws(() => patchNumericBinding(original, binding, 31, 36), { code: "SOURCE_DRIFT" });
});

test("requires proposal confirmation, applies atomically, and reverts only recorded values", async (context) => {
  const { projectRoot, workbenchRoot, model, service } = await createFixture(context);
  const proposal = await service.propose(proposedChangeSet(model));
  await assert.rejects(() => service.apply({ ...proposal, confirmed: false }), { code: "CONFIRMATION_REQUIRED" });

  const receipt = await service.apply({ proposalId: proposal.proposalId, digest: proposal.digest, confirmed: true });
  const sourcePath = join(projectRoot, "src", "game", "GameTuningConfig.js");
  assert.equal(receipt.state, "applied");
  assert.match(await readFile(sourcePath, "utf8"), /maxHealth: 125,/);
  const snapshot = JSON.parse(await readFile(join(workbenchRoot, "game-tuning-model.json"), "utf8"));
  assert.equal(snapshot.tuningParameters[0].currentValue, 125);
  await access(join(workbenchRoot, ".gtw-history", receipt.receiptId, "receipt.json"));

  await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n// unrelated user note\n`, "utf8");
  const reverted = await service.revert(receipt.receiptId);
  const revertedSource = await readFile(sourcePath, "utf8");
  assert.equal(reverted.state, "reverted");
  assert.match(revertedSource, /maxHealth: 100,/);
  assert.match(revertedSource, /unrelated user note/);
  const revertedSnapshot = JSON.parse(await readFile(join(workbenchRoot, "game-tuning-model.json"), "utf8"));
  assert.equal(revertedSnapshot.tuningParameters[0].currentValue, 100);
});

test("blocks a proposal when the source no longer matches before", async (context) => {
  const { model, service } = await createFixture(context, fixtureSource(110));
  await assert.rejects(() => service.propose(proposedChangeSet(model)), { code: "SOURCE_DRIFT" });
});

test("keeps Codex-assisted semantic operations out of the local apply engine", async () => {
  const pluginRoot = join(import.meta.dirname, "..");
  const model = JSON.parse(await readFile(join(pluginRoot, "examples", "minimal-threejs-model.json"), "utf8"));
  const draft = createWorldviewDraft(model.worldview.cards[0], {
    title: "新的星空设定",
    body: "玩家在新的星空航道中守卫信标。",
  });
  const changeSet = {
    ...buildDraftChangeSet(model, { [draft.targetId]: draft }, "2026-08-31T00:00:00.000Z"),
    state: "proposed",
  };
  assert.throws(() => validateProposedChangeSet(model, changeSet), /Codex-assisted operations cannot enter/);
});

test("manages playtest checks, screenshot evidence, verification, and verified rollback", async (context) => {
  const { model, service } = await createFixture(context);
  const proposal = await service.propose(proposedChangeSet(model));
  let receipt = await service.apply({ proposalId: proposal.proposalId, digest: proposal.digest, confirmed: true });

  const history = await service.listReceipts();
  assert.equal(history.length, 1);
  assert.equal(history[0].playtest.checks.length, 2);
  assert.equal(history[0].playtest.status, "not-run");

  const passedChecks = receipt.playtest.checks.map((check) => ({ ...check, status: "passed" }));
  await assert.rejects(
    () => service.updatePlaytest(receipt.receiptId, { status: "passed", checks: passedChecks, notes: "feels right" }),
    { code: "VERIFICATION_BLOCKED" },
  );

  receipt = await service.addEvidence(receipt.receiptId, {
    label: "生命值试玩结果",
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });
  assert.equal(receipt.playtest.evidence.length, 1);
  const evidence = await service.getEvidence(receipt.receiptId, receipt.playtest.evidence[0].evidenceId);
  await access(evidence.path);

  receipt = await service.updatePlaytest(receipt.receiptId, { status: "passed", checks: passedChecks, notes: "试玩通过" });
  assert.equal(receipt.state, "verified");
  assert.equal(receipt.changeSet.state, "verified");
  assert.equal(receipt.changeSet.verification.status, "passed");

  receipt = await service.deleteEvidence(receipt.receiptId, receipt.playtest.evidence[0].evidenceId);
  assert.equal(receipt.state, "applied");
  receipt = await service.addEvidence(receipt.receiptId, {
    label: "复测截图",
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });
  receipt = await service.updatePlaytest(receipt.receiptId, { status: "passed", checks: passedChecks, notes: "复测通过" });
  assert.equal(receipt.state, "verified");

  const reverted = await service.revert(receipt.receiptId);
  assert.equal(reverted.state, "reverted");
});

test("generates apply mode separately from the explicit source-write gate", async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "gtw-apply-output-"));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const pluginRoot = join(import.meta.dirname, "..");
  const result = await generateApplyWorkbench(join(pluginRoot, "examples", "minimal-threejs-model.json"), outputRoot);
  const metadata = JSON.parse(await readFile(join(outputRoot, "workbench-meta.json"), "utf8"));
  const appSource = await readFile(join(outputRoot, "app.js"), "utf8");
  assert.equal(result.metadata.mode, "apply");
  assert.equal(metadata.mode, "apply");
  assert.match(appSource, /data-propose-changeset/);
  assert.match(appSource, /data-apply-proposal/);
  assert.match(appSource, /data-start-preview/);
  assert.match(appSource, /data-save-verification/);
  assert.match(appSource, /data-upload-evidence/);
  assert.doesNotMatch(appSource, /writeFile|node:fs/);
});
