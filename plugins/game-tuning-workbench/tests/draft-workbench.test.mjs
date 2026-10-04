import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDraftChangeSet,
  createAssetDraft,
  createGameplayDraft,
  createWorldviewDraft,
  normalizeDraftValue,
} from "../assets/workbench/draft-model.js";
import { generateDraftWorkbench } from "../scripts/generate-draft-workbench.mjs";
import { portableExampleModel } from '../scripts/example-model.mjs';

const pluginRoot = join(import.meta.dirname, "..");

test("normalizes draft values to the declared safe range and step", () => {
  const parameter = { safeRange: { min: 2, max: 12, step: 0.1 } };
  assert.equal(normalizeDraftValue(parameter, 5.76), 5.8);
  assert.equal(normalizeDraftValue(parameter, -20), 2);
  assert.equal(normalizeDraftValue(parameter, 99), 12);
  assert.equal(normalizeDraftValue(parameter, "not-a-number"), null);
});

test("builds independent source-bound operations without applying them", async () => {
  const model = await portableExampleModel();
  const first = model.tuningParameters[0];
  const second = model.tuningParameters[1];
  const drafts = {
    [first.id]: { targetId: first.id, before: first.currentValue, after: first.currentValue + first.safeRange.step },
    [second.id]: { targetId: second.id, before: second.currentValue, after: second.currentValue + second.safeRange.step },
  };
  const changeSet = buildDraftChangeSet(model, drafts, "2026-08-31T00:00:00.000Z");

  assert.equal(changeSet.state, "draft");
  assert.equal(changeSet.confirmation.confirmedAt, null);
  assert.equal(changeSet.verification.status, "not-run");
  assert.deepEqual(changeSet.operations.map((operation) => operation.targetId), [first.id, second.id]);
  assert.deepEqual(changeSet.operations.map((operation) => operation.sourceBinding), [first.sourceBinding, second.sourceBinding]);
  assert.deepEqual(changeSet.operations.map((operation) => operation.before), [first.currentValue, second.currentValue]);
  assert.deepEqual(changeSet.operations.map((operation) => operation.after), [drafts[first.id].after, drafts[second.id].after]);
  assert.match(changeSet.impact.warnings[0], /尚未写入源码/);
  assert(changeSet.operations.every((operation) => operation.application.strategy === "automatic"));
});

test("builds isolated Codex-assisted worldview, gameplay, and asset operations", async () => {
  const model = JSON.parse(await readFile(join(pluginRoot, "examples", "minimal-threejs-model.json"), "utf8"));
  const worldview = createWorldviewDraft(model.worldview.cards[0], {
    title: "明亮星海防线",
    body: "玩家守卫一条充满信标的明亮星空航道。",
  });
  const gameplay = createGameplayDraft(model.coreGameplay.rules[0], {
    trigger: "敌人进入生成队列",
    condition: "玩家仍有观察方向提示的时间",
    result: "先显示方向警告，再生成敌人",
    playerFeedback: "生成位置出现高对比方向标记",
  });
  const asset = createAssetDraft(model.assets[0], {
    capability: "model.generate",
    prompt: "明亮、低多边形、轮廓清晰的街机主角飞船",
  });
  const changeSet = buildDraftChangeSet(model, {
    [worldview.targetId]: worldview,
    [gameplay.targetId]: gameplay,
    [asset.targetId]: asset,
  }, "2026-08-31T00:10:00.000Z");

  assert.deepEqual(changeSet.operations.map((operation) => operation.type), ["edit-worldview", "edit-gameplay", "replace-asset"]);
  assert(changeSet.operations.every((operation) => operation.application.strategy === "codex-assisted"));
  assert(changeSet.operations.every((operation) => operation.application.executor === "codex"));
  assert.equal(changeSet.operations[0].after.title, "明亮星海防线");
  assert.equal(changeSet.operations[1].after.result, "先显示方向警告，再生成敌人");
  assert.equal(changeSet.operations[2].after.generationRequest.assetSlotId, "asset.player-main");
  assert.equal(changeSet.operations[2].after.selectedOutput, null);
  assert.match(changeSet.summary, /0 项可精确应用，3 项需 Codex 辅助/);
  assert(changeSet.impact.excludedEffects.includes("不自动修改数值参数"));
});

test("marks generated-runtime asset requests as requiring a runtime adapter", async () => {
  const model = await portableExampleModel();
  const draft = createAssetDraft(model.assets[0], {
    capability: "model.generate",
    prompt: "低多边形港区场景",
  });
  assert.deepEqual(draft.after.generationRequest.constraints.acceptedMimeTypes, ["model/gltf-binary"]);
  assert.equal(draft.after.generationRequest.constraints.requiresRuntimeAdapter, true);
});

test("generates a draft-mode workbench without source-application code", async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "gtw-draft-output-"));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const modelPath = join(pluginRoot, "examples", "minimal-threejs-model.json");
  const result = await generateDraftWorkbench(modelPath, outputRoot);
  const metadata = JSON.parse(await readFile(join(outputRoot, "workbench-meta.json"), "utf8"));
  const appSource = await readFile(join(outputRoot, "app.js"), "utf8");

  assert.equal(result.metadata.mode, "draft");
  assert.equal(metadata.mode, "draft");
  assert.match(appSource, /type=\"range\"/);
  assert.match(appSource, /localStorage/);
  assert.match(appSource, /data-edit-worldview/);
  assert.match(appSource, /data-edit-gameplay/);
  assert.match(appSource, /data-edit-asset/);
  assert.match(appSource, /data-download-changeset/);
  assert.doesNotMatch(appSource, /data-confirm-apply|writeSource|applyChangeSet/);
});
