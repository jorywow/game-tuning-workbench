function decimalPlaces(value) {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function firstBinding(target, type) {
  if (type === "set-parameter") return target.sourceBinding;
  if (type === "replace-asset") return target.source;
  return target.sourceBindings?.[0];
}

function targetIndex(model) {
  return {
    parameterById: new Map((model.tuningParameters ?? []).map((item) => [item.id, item])),
    worldviewById: new Map((model.worldview?.cards ?? []).map((item) => [item.id, item])),
    gameplayById: new Map((model.coreGameplay?.rules ?? []).map((item) => [item.id, item])),
    assetById: new Map((model.assets ?? []).map((item) => [item.id, item])),
  };
}

function operationTarget(index, type, targetId) {
  if (type === "set-parameter") return index.parameterById.get(targetId);
  if (type === "edit-worldview") return index.worldviewById.get(targetId);
  if (type === "edit-gameplay") return index.gameplayById.get(targetId);
  if (type === "replace-asset") return index.assetById.get(targetId);
  return null;
}

function defaultStrategy(type) {
  return type === "set-parameter" ? "automatic" : "codex-assisted";
}

function operationEffects(type, target) {
  if (type === "set-parameter") {
    return {
      expected: target.effects.direct.map((effect) => `${target.label}：${effect}`),
      excluded: target.effects.excluded,
    };
  }
  if (type === "edit-worldview") {
    return {
      expected: [`更新世界观卡片「${target.title}」的表达，并由 Codex 对照源码证据实施`],
      excluded: ["不自动修改玩法规则", "不自动修改数值参数", "不自动替换关联素材"],
    };
  }
  if (type === "edit-gameplay") {
    return {
      expected: [`按新规则描述调整「${target.label}」，并由 Codex 保留现有系统边界`],
      excluded: ["不自动修改世界观", "不自动联动其他玩法规则", "不自动修改数值参数或素材"],
    };
  }
  return {
    expected: [`为素材槽位「${target.label}」准备生成与替换方案`],
    excluded: ["不自动修改玩法逻辑", "不自动修改世界观或数值参数", "生成结果确认前不覆盖当前素材"],
  };
}

function humanType(type) {
  return {
    "set-parameter": "数值",
    "edit-worldview": "世界观",
    "edit-gameplay": "玩法规则",
    "replace-asset": "素材",
  }[type] ?? type;
}

export function normalizeDraftValue(parameter, rawValue) {
  const range = parameter.safeRange;
  const value = Number(rawValue);
  if (!range || !Number.isFinite(value)) return null;
  const step = Number(range.step) || 1;
  const snapped = range.min + Math.round((value - range.min) / step) * step;
  const clamped = Math.max(range.min, Math.min(range.max, snapped));
  const precision = Math.max(decimalPlaces(step), decimalPlaces(range.min));
  return Number(clamped.toFixed(Math.min(precision, 10)));
}

export function createWorldviewDraft(card, candidate) {
  const after = {
    title: String(candidate.title ?? "").trim(),
    body: String(candidate.body ?? "").trim(),
  };
  if (!after.title || !after.body) throw new Error("世界观标题和正文都不能为空。");
  return {
    type: "edit-worldview",
    targetId: card.id,
    before: { title: card.title, body: card.body },
    after,
    applicationStrategy: "codex-assisted",
    reason: String(candidate.reason ?? "让世界设定更符合当前创作方向").trim(),
    updatedAt: new Date().toISOString(),
  };
}

export function createGameplayDraft(rule, candidate) {
  const after = {
    trigger: String(candidate.trigger ?? "").trim(),
    condition: String(candidate.condition ?? "").trim(),
    result: String(candidate.result ?? "").trim(),
    playerFeedback: String(candidate.playerFeedback ?? "").trim(),
  };
  if (Object.values(after).some((value) => !value)) throw new Error("玩法规则的四个字段都不能为空。");
  return {
    type: "edit-gameplay",
    targetId: rule.id,
    before: {
      trigger: rule.trigger,
      condition: rule.condition,
      result: rule.result,
      playerFeedback: rule.playerFeedback,
    },
    after,
    applicationStrategy: "codex-assisted",
    reason: String(candidate.reason ?? "调整这条规则的玩家体验").trim(),
    updatedAt: new Date().toISOString(),
  };
}

export function createAssetDraft(asset, candidate) {
  const prompt = String(candidate.prompt ?? "").trim();
  if (!prompt) throw new Error("素材生成描述不能为空。");
  const capability = candidate.capability ?? (asset.technicalContract.kind === "model" ? "model.generate" : "image.generate");
  const declaredMimeTypes = asset.technicalContract.acceptedMimeTypes ?? [];
  const constraints = compactObject({
    acceptedMimeTypes: declaredMimeTypes.length > 0
      ? [...declaredMimeTypes]
      : capability === "model.generate" ? ["model/gltf-binary"] : ["image/png"],
    requiresRuntimeAdapter: asset.technicalContract.kind === "generated-runtime" || undefined,
    width: asset.technicalContract.width,
    height: asset.technicalContract.height,
    requiresTransparency: asset.technicalContract.requiresTransparency,
    modelFormats: asset.technicalContract.modelFormats,
    requiresAnimations: asset.technicalContract.requiresAnimations,
    maxPolygonCount: asset.technicalContract.maxPolygonCount,
  });
  return {
    type: "replace-asset",
    targetId: asset.id,
    before: {
      label: asset.label,
      sourceFile: asset.source.file,
      preview: asset.preview,
    },
    after: {
      generationRequest: compactObject({
        requestId: `request.${asset.id.replace(/^asset\./, "")}.draft`,
        providerId: String(candidate.providerId ?? "provider.pending").trim() || "provider.pending",
        capability,
        assetSlotId: asset.id,
        prompt,
        negativePrompt: String(candidate.negativePrompt ?? "").trim() || undefined,
        referenceFiles: [asset.source.file],
        constraints,
      }),
      selectedOutput: null,
      preserveGameplayBindings: true,
    },
    applicationStrategy: "codex-assisted",
    reason: String(candidate.reason ?? "生成候选素材，确认后再替换当前槽位").trim(),
    updatedAt: new Date().toISOString(),
  };
}

export function buildDraftChangeSet(model, drafts, createdAt = new Date().toISOString()) {
  const entries = Object.values(drafts);
  const index = targetIndex(model);
  const operations = entries.map((draft, position) => {
    const type = draft.type ?? "set-parameter";
    const target = operationTarget(index, type, draft.targetId);
    if (!target) throw new Error(`草稿目标不存在：${draft.targetId}`);
    const sourceBinding = firstBinding(target, type);
    if (!sourceBinding) throw new Error(`草稿目标缺少源码证据：${draft.targetId}`);
    const strategy = draft.applicationStrategy ?? defaultStrategy(type);
    return {
      operationId: `operation.${type}-${position + 1}`,
      type,
      targetId: target.id,
      application: {
        strategy,
        executor: strategy === "automatic" ? "local-apply-engine" : "codex",
        reason: strategy === "automatic"
          ? "存在经过确认的精确可写源码绑定"
          : "当前只有只读或语义级源码证据，需要 Codex 审查并实施",
      },
      sourceBinding,
      before: draft.before,
      after: draft.after,
      reason: draft.reason || `预览「${target.label ?? target.title ?? target.id}」的调整`,
    };
  });

  const targetIds = new Set(operations.map((operation) => operation.targetId));
  const dependentTargetIds = unique((model.dependencies ?? [])
    .flatMap((dependency) => {
      if (targetIds.has(dependency.from)) return [dependency.to];
      if (targetIds.has(dependency.to)) return [dependency.from];
      return [];
    })
    .filter((id) => !targetIds.has(id)));
  const effects = operations.map((operation) => operationEffects(
    operation.type,
    operationTarget(index, operation.type, operation.targetId),
  ));
  const automaticCount = operations.filter((operation) => operation.application.strategy === "automatic").length;
  const assistedCount = operations.length - automaticCount;
  const categories = unique(operations.map((operation) => humanType(operation.type))).join("、");

  return {
    schemaVersion: "0.2.0",
    changeSetId: "change.draft-preview",
    modelId: model.modelId,
    createdAt,
    state: "draft",
    summary: `预览 ${entries.length} 项${categories}草稿：${automaticCount} 项可精确应用，${assistedCount} 项需 Codex 辅助`,
    operations,
    impact: {
      expectedEffects: unique(effects.flatMap((effect) => effect.expected)),
      dependentTargetIds,
      excludedEffects: unique(effects.flatMap((effect) => effect.excluded)),
      warnings: unique([
        "当前仅生成草稿；尚未写入源码，也未完成真实游戏试玩验证。",
        assistedCount > 0 ? `${assistedCount} 项语义变更必须由 Codex 对照源码实施，不能交给本地精确值写入器。` : null,
      ]),
    },
    confirmation: { required: true, confirmedAt: null },
    verification: {
      status: "not-run",
      checks: [
        { type: "build", description: "应用后运行项目现有构建命令", status: "not-run" },
        { type: "browser", description: "应用后试玩受影响行为，并确认排除项保持不变", status: "not-run" },
        ...(operations.some((operation) => operation.type === "replace-asset")
          ? [{ type: "asset-contract", description: "确认候选素材满足槽位格式、尺寸与绑定约束", status: "not-run" }]
          : []),
      ],
      evidence: [],
    },
    rollback: { available: true, strategy: "restore-recorded-before-values", status: "not-run" },
  };
}
