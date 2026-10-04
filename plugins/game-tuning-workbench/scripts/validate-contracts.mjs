#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { portableExampleModel } from './example-model.mjs';
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDraftChangeSet,
  createAssetDraft,
  createGameplayDraft,
  createWorldviewDraft,
} from "../assets/workbench/draft-model.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stableIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(relativePath) {
  const raw = await readFile(join(pluginRoot, relativePath), "utf8");
  return JSON.parse(raw);
}

function assertStableId(value, context) {
  assert(typeof value === "string" && stableIdPattern.test(value), `${context} must be a stable ID`);
}

function assertUniqueIds(items, context) {
  const ids = new Set();
  for (const item of items) {
    assertStableId(item.id, `${context}.id`);
    assert(!ids.has(item.id), `${context} contains duplicate ID ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function assertEvidenceRefs(item, evidenceIds, context) {
  assert(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0, `${context} needs evidenceRefs`);
  for (const evidenceId of item.evidenceRefs) {
    assert(evidenceIds.has(evidenceId), `${context} references unknown evidence ${evidenceId}`);
  }
}

function assertValueType(parameter) {
  const value = parameter.currentValue;
  const expected = parameter.valueType;
  if (expected === "number") {
    assert(typeof value === "number" && Number.isFinite(value), `${parameter.id} needs a finite number`);
  } else if (expected === "integer") {
    assert(Number.isInteger(value), `${parameter.id} needs an integer`);
  } else if (expected === "boolean") {
    assert(typeof value === "boolean", `${parameter.id} needs a boolean`);
  } else if (expected === "enum") {
    assert(typeof value === "string", `${parameter.id} needs an enum string`);
    assert(Array.isArray(parameter.options) && parameter.options.includes(value), `${parameter.id} currentValue is not an option`);
  } else {
    throw new Error(`${parameter.id} has unsupported valueType ${expected}`);
  }

  if (parameter.safeRange) {
    const { min, max } = parameter.safeRange;
    assert(min <= max, `${parameter.id} safeRange min must be <= max`);
    assert(typeof value === "number" && value >= min && value <= max, `${parameter.id} currentValue is outside safeRange`);
    assert(
      typeof parameter.defaultValue === "number" && parameter.defaultValue >= min && parameter.defaultValue <= max,
      `${parameter.id} defaultValue is outside safeRange`,
    );
  }
}

function validateModel(model) {
  assert(model.schemaVersion === "0.1.0", "model schemaVersion must be 0.1.0");
  assertStableId(model.modelId, "modelId");
  assert(model.project?.engine === "three", "only the Three.js engine is supported");
  assert(Array.isArray(model.project.entryPoints) && model.project.entryPoints.length > 0, "project needs an entry point");
  assert(model.project.coverage >= 0 && model.project.coverage <= 1, "project coverage must be between 0 and 1");

  const evidenceIds = assertUniqueIds(model.evidence, "evidence");
  const worldviewCards = model.worldview?.cards ?? [];
  const loopSteps = model.coreGameplay?.loopSteps ?? [];
  const rules = model.coreGameplay?.rules ?? [];
  const parameters = model.tuningParameters ?? [];
  const assets = model.assets ?? [];
  const targets = [...worldviewCards, ...loopSteps, ...rules, ...parameters, ...assets];
  const targetIds = assertUniqueIds(targets, "model targets");

  for (const [groupName, items] of Object.entries({ worldviewCards, loopSteps, rules, parameters, assets })) {
    for (const item of items) {
      assertEvidenceRefs(item, evidenceIds, `${groupName}.${item.id}`);
    }
  }

  const parameterById = new Map();
  for (const parameter of parameters) {
    assert(parameter.confidence === "confirmed", `${parameter.id} cannot be tunable until it is confirmed`);
    assertStableId(parameter.ownerId, `${parameter.id}.ownerId`);
    assert(parameter.sourceBinding?.access === "editable", `${parameter.id} needs one editable source binding`);
    assert(typeof parameter.previewBinding?.consumer === "string", `${parameter.id} needs a preview consumer`);
    assert(Array.isArray(parameter.effects?.direct) && parameter.effects.direct.length > 0, `${parameter.id} needs direct effects`);
    assert(Array.isArray(parameter.effects?.excluded) && parameter.effects.excluded.length > 0, `${parameter.id} needs excluded effects`);
    assertValueType(parameter);
    parameterById.set(parameter.id, parameter);
  }

  const assetById = new Map();
  for (const asset of assets) {
    assert(asset.replacementPolicy?.preserveGameplayBindings === true, `${asset.id} must preserve gameplay bindings`);
    assert(Array.isArray(asset.technicalContract?.acceptedMimeTypes), `${asset.id} needs accepted MIME types`);
    assetById.set(asset.id, asset);
  }

  for (const dependency of model.dependencies ?? []) {
    assert(targetIds.has(dependency.from), `dependency.from references unknown target ${dependency.from}`);
    assert(targetIds.has(dependency.to), `dependency.to references unknown target ${dependency.to}`);
    assert(dependency.from !== dependency.to, `dependency ${dependency.from} cannot target itself`);
  }

  return { parameterById, assetById, targetIds };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateChangeSet(changeSet, modelIndex, expectedModelId) {
  assert(changeSet.schemaVersion === "0.2.0", "ChangeSet schemaVersion must be 0.2.0");
  assertStableId(changeSet.changeSetId, "changeSetId");
  assert(changeSet.modelId === expectedModelId, `ChangeSet must target ${expectedModelId}`);
  assert(Array.isArray(changeSet.operations) && changeSet.operations.length > 0, "ChangeSet needs operations");
  assert(changeSet.confirmation?.required === true, "ChangeSet confirmation must be required");
  assert(changeSet.rollback?.available === true, "ChangeSet rollback must be available");
  assert(Array.isArray(changeSet.impact?.excludedEffects) && changeSet.impact.excludedEffects.length > 0, "ChangeSet needs excluded effects");

  const confirmedStates = new Set(["applied", "verified", "failed", "reverted"]);
  if (confirmedStates.has(changeSet.state)) {
    assert(typeof changeSet.confirmation.confirmedAt === "string", `${changeSet.state} ChangeSet needs confirmedAt`);
  }
  if (changeSet.state === "verified") {
    assert(changeSet.verification?.status === "passed", "verified ChangeSet needs passed verification");
  }
  if (changeSet.state === "reverted") {
    assert(changeSet.rollback?.status === "passed", "reverted ChangeSet needs passed rollback");
  }

  for (const operation of changeSet.operations) {
    assertStableId(operation.operationId, "operationId");
    assert(modelIndex.targetIds.has(operation.targetId), `operation targets unknown ID ${operation.targetId}`);
    assert(new Set(["automatic", "codex-assisted"]).has(operation.application?.strategy), `${operation.operationId} needs an application strategy`);
    assert(new Set(["local-apply-engine", "codex"]).has(operation.application?.executor), `${operation.operationId} needs an executor`);

    if (operation.type === "set-parameter") {
      const parameter = modelIndex.parameterById.get(operation.targetId);
      assert(parameter, `${operation.targetId} is not a tuning parameter`);
      assert(sameJson(operation.sourceBinding, parameter.sourceBinding), `${operation.operationId} source binding drifted from the model`);
      assert(sameJson(operation.before, parameter.currentValue), `${operation.operationId} before-value does not match the model`);
      assert(operation.sourceBinding.access === "editable", `${operation.operationId} needs an editable source binding`);
      assert(operation.application.strategy === "automatic", `${operation.operationId} must be automatic`);
      assert(operation.application.executor === "local-apply-engine", `${operation.operationId} must use the local apply engine`);
    } else {
      assert(operation.application.strategy === "codex-assisted", `${operation.operationId} must be Codex-assisted`);
      assert(operation.application.executor === "codex", `${operation.operationId} must use Codex`);
    }
  }
}

function validateAssetRequest(request, modelIndex) {
  assertStableId(request.requestId, "asset request ID");
  assertStableId(request.providerId, "provider ID");
  const asset = modelIndex.assetById.get(request.assetSlotId);
  assert(asset, `asset request targets unknown slot ${request.assetSlotId}`);
  assert(typeof request.prompt === "string" && request.prompt.length > 0, "asset request needs a prompt");

  const slotMimeTypes = new Set(asset.technicalContract.acceptedMimeTypes);
  if (slotMimeTypes.size > 0) {
    for (const mimeType of request.constraints.acceptedMimeTypes ?? []) {
      assert(slotMimeTypes.has(mimeType), `asset request MIME type ${mimeType} violates the slot contract`);
    }
  } else {
    assert(request.constraints.requiresRuntimeAdapter === true, "a generated-runtime slot needs an explicit runtime adapter");
  }

  if (request.constraints.maxPolygonCount && asset.technicalContract.maxPolygonCount) {
    assert(
      request.constraints.maxPolygonCount <= asset.technicalContract.maxPolygonCount,
      "asset request polygon budget exceeds the slot contract",
    );
  }
}

async function main() {
  const schemaPaths = [
    "schemas/game-tuning-model.schema.json",
    "schemas/change-set.schema.json",
    "schemas/asset-generation-request.schema.json",
  ];
  for (const schemaPath of schemaPaths) {
    const schema = await readJson(schemaPath);
    assert(schema.$schema?.includes("2020-12"), `${schemaPath} must use JSON Schema 2020-12`);
    assert(schema.additionalProperties === false, `${schemaPath} must reject unknown root fields`);
  }

  const modelPaths = [
    "examples/minimal-threejs-model.json",
  ];
  const models = await Promise.all(modelPaths.map((path) => readJson(path)));
  models.push(await portableExampleModel());
  const model = models[0];
  const changeSet = await readJson("examples/draft-change-set.json");
  const assetRequest = await readJson("examples/asset-generation-request.json");
  const providerContract = await readFile(join(pluginRoot, "contracts/asset-provider.ts"), "utf8");
  assert(providerContract.includes("export interface AssetProvider"), "asset provider interface is missing");

  const modelIndexes = models.map((candidate) => validateModel(candidate));
  const modelIndex = modelIndexes[0];
  validateChangeSet(changeSet, modelIndex, model.modelId);
  const analyzedModel = models[1];
  const analyzedIndex = modelIndexes[1];
  const draftParameters = analyzedModel.tuningParameters.slice(0, 2);
  const generatedDraft = buildDraftChangeSet(
    analyzedModel,
    Object.fromEntries(draftParameters.map((parameter) => [parameter.id, {
      targetId: parameter.id,
      before: parameter.currentValue,
      after: parameter.currentValue + parameter.safeRange.step,
    }])),
    "2026-08-31T00:00:00.000Z",
  );
  validateChangeSet(generatedDraft, analyzedIndex, analyzedModel.modelId);
  const contentDraft = buildDraftChangeSet(model, {
    "world.setting": createWorldviewDraft(model.worldview.cards[0], {
      title: "更明亮的星空防线",
      body: "玩家在明亮的星空航道中守住最后一道防线。",
    }),
    "rule.enemy-spawn-warning": createGameplayDraft(model.coreGameplay.rules[0], {
      trigger: "敌人进入生成队列",
      condition: "场上仍有安全提示空间",
      result: "显示警告后再生成敌人",
      playerFeedback: "生成位置出现清晰的方向警告",
    }),
    "asset.player-main": createAssetDraft(model.assets[0], {
      capability: "model.generate",
      prompt: "明亮、低多边形的街机主角飞船",
    }),
  }, "2026-08-31T00:10:00.000Z");
  validateChangeSet(contentDraft, modelIndex, model.modelId);
  validateAssetRequest(contentDraft.operations.find((operation) => operation.type === "replace-asset").after.generationRequest, modelIndex);
  const generatedRuntimeAssetDraft = createAssetDraft(analyzedModel.assets[0], {
    capability: "model.generate",
    prompt: "用于港区的低多边形场景候选",
  });
  validateAssetRequest(generatedRuntimeAssetDraft.after.generationRequest, analyzedIndex);
  validateAssetRequest(assetRequest, modelIndex);

  console.log("Contract validation passed:");
  console.log(`- ${schemaPaths.length} JSON Schemas parsed`);
  console.log(`- ${models.length} game models checked`);
  console.log(`- ${modelIndexes.reduce((total, index) => total + index.targetIds.size, 0)} model targets checked`);
  console.log(`- ${changeSet.operations.length + generatedDraft.operations.length + contentDraft.operations.length} draft operations checked across 3 ChangeSets`);
  console.log("- asset provider request matches its slot contract");
}

main().catch((error) => {
  console.error(`Contract validation failed: ${error.message}`);
  process.exitCode = 1;
});
