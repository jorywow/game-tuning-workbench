import {
  buildDraftChangeSet as createDraftChangeSet,
  createAssetDraft,
  createGameplayDraft,
  createWorldviewDraft,
  normalizeDraftValue,
} from "./draft-model.js";

const VIEW_META = {
  overview: { index: "00", label: "项目概览", kicker: "PROJECT STATUS" },
  worldview: { index: "01", label: "世界观", kicker: "WORLD & NARRATIVE" },
  gameplay: { index: "02", label: "核心玩法", kicker: "CORE GAMEPLAY" },
  tuning: { index: "03", label: "数值调优", kicker: "TUNING PARAMETERS" },
  preview: { index: "04", label: "A/B 试玩", kicker: "RUNTIME DRAFT PREVIEW" },
  assets: { index: "05", label: "素材库", kicker: "ASSET SLOTS" },
  verification: { index: "06", label: "验证与撤销", kicker: "PLAYTEST & ROLLBACK" },
};

const GROUP_LABELS = {
  controls: "操作手感",
  "combat-pressure": "战斗压力",
  pacing: "游戏节奏",
  rewards: "成长与奖励",
  forgiveness: "容错与难度",
  "visual-feedback": "视听反馈",
};

const CATEGORY_LABELS = {
  player: "玩家",
  enemy: "敌人",
  environment: "场景",
  ui: "界面",
  effect: "特效",
  audio: "音频",
  model: "模型",
  animation: "动画",
};

const state = {
  model: null,
  metadata: null,
  mode: "readonly",
  view: "overview",
  query: "",
  tuningGroup: "all",
  drafts: {},
  applyStatus: { loaded: false, proposalEnabled: false, enabled: false, buildVerification: false, runtimePreviewEnabled: false },
  activeProposal: null,
  receipt: null,
  receipts: [],
  selectedReceiptId: null,
  preview: { active: false, sourceUnchanged: true, session: null, changeSet: null },
  previewVariant: "baseline",
};

const app = document.querySelector("#app");
const dialog = document.querySelector("#detail-dialog");
const dialogKicker = document.querySelector("[data-dialog-kicker]");
const dialogTitle = document.querySelector("#detail-title");
const dialogContent = document.querySelector("#detail-content");
app.dataset.ready = "loading";

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function humanizeProjectName(value) {
  return String(value ?? "未命名游戏")
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return escapeHTML(value);
  const number = Number(value);
  if (Math.abs(number) >= 1000) return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return String(Number(number.toFixed(5)));
}

function isDraftMode() {
  return state.mode === "draft" || state.mode === "apply";
}

function isApplyMode() {
  return state.mode === "apply";
}

function draftEntries() {
  return Object.values(state.drafts);
}

function parameterDraftEntries() {
  return draftEntries().filter((draft) => (draft.type ?? "set-parameter") === "set-parameter");
}

function assistedDraftEntries() {
  return draftEntries().filter((draft) => (draft.applicationStrategy ?? ((draft.type ?? "set-parameter") === "set-parameter" ? "automatic" : "codex-assisted")) === "codex-assisted");
}

function draftCount() {
  return draftEntries().length;
}

function parameterDraftCount() {
  return parameterDraftEntries().length;
}

function getParameter(id) {
  return state.model.tuningParameters.find((parameter) => parameter.id === id) ?? null;
}

function getWorldviewCard(id) {
  return state.model.worldview.cards.find((card) => card.id === id) ?? null;
}

function getGameplayRule(id) {
  return state.model.coreGameplay.rules.find((rule) => rule.id === id) ?? null;
}

function getAsset(id) {
  return state.model.assets.find((asset) => asset.id === id) ?? null;
}

function currentDraftValue(parameter) {
  return state.drafts[parameter.id]?.after ?? parameter.currentValue;
}

function hasDraft(parameter) {
  return Object.hasOwn(state.drafts, parameter.id);
}

function draftStorageKey() {
  return `game-tuning-workbench:draft:${state.model.modelId}`;
}

function persistDrafts() {
  if (!isDraftMode()) return;
  try {
    const key = draftStorageKey();
    if (draftCount() === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ schemaVersion: "0.2.0", drafts: state.drafts }));
  } catch {
    // The UI remains usable for the current tab when browser storage is unavailable.
  }
}

function loadDrafts() {
  if (!isDraftMode()) return;
  try {
    const stored = JSON.parse(localStorage.getItem(draftStorageKey()) ?? "null");
    if (!new Set(["0.1.0", "0.2.0"]).has(stored?.schemaVersion) || !stored.drafts) return;
    for (const [id, draft] of Object.entries(stored.drafts)) {
      const type = draft.type ?? "set-parameter";
      if (type === "set-parameter") {
        const parameter = getParameter(id);
        if (!parameter || draft.before !== parameter.currentValue) continue;
        const after = normalizeDraftValue(parameter, draft.after);
        if (after === null || after === parameter.currentValue) continue;
        state.drafts[id] = { type, targetId: id, before: parameter.currentValue, after, applicationStrategy: "automatic", updatedAt: draft.updatedAt ?? null };
        continue;
      }
      const target = type === "edit-worldview" ? getWorldviewCard(id) : type === "edit-gameplay" ? getGameplayRule(id) : getAsset(id);
      if (!target || JSON.stringify(draft.before) !== JSON.stringify(contentBefore(type, target))) continue;
      state.drafts[id] = draft;
    }
  } catch {
    state.drafts = {};
  }
}

function setDraftValue(parameter, rawValue) {
  const after = normalizeDraftValue(parameter, rawValue);
  if (after === null) return null;
  if (after === parameter.currentValue) delete state.drafts[parameter.id];
  else {
    state.drafts[parameter.id] = {
      type: "set-parameter",
      targetId: parameter.id,
      before: parameter.currentValue,
      after,
      applicationStrategy: "automatic",
      updatedAt: new Date().toISOString(),
    };
  }
  persistDrafts();
  updateDraftChrome();
  return after;
}

function contentBefore(type, target) {
  if (type === "edit-worldview") return { title: target.title, body: target.body };
  if (type === "edit-gameplay") {
    return {
      trigger: target.trigger,
      condition: target.condition,
      result: target.result,
      playerFeedback: target.playerFeedback,
    };
  }
  return { label: target.label, sourceFile: target.source.file, preview: target.preview };
}

function setContentDraft(draft) {
  if (JSON.stringify(draft.before) === JSON.stringify(draft.after)) delete state.drafts[draft.targetId];
  else state.drafts[draft.targetId] = draft;
  persistDrafts();
  updateDraftChrome();
}

function clearDraft(parameterId) {
  delete state.drafts[parameterId];
  persistDrafts();
  updateDraftChrome();
}

function modeLabel() {
  if (isApplyMode()) return state.applyStatus.enabled ? "确认应用模式" : "确认应用 · 安全锁定";
  return isDraftMode() ? "浏览器草稿模式" : "只读检查模式";
}

function modeNote() {
  if (isApplyMode()) {
    if (!state.applyStatus.enabled) return state.applyStatus.proposalEnabled ? "可预览二次确认；源码写入仍保持锁定。" : "确认服务不可用；当前只能预览草稿。";
    return draftCount() > 0 ? "草稿尚未写入；确认前会再次检查源码。" : "写入权限仅限已批准的项目根目录。";
  }
  if (isDraftMode()) return draftCount() > 0 ? "草稿尚未写入游戏源码，可以随时撤销。" : "草稿保存在当前浏览器；游戏源码保持不变。";
  return "当前页面不会保存参数，也不会修改游戏源码。";
}

function confidenceLabel(confidence) {
  return { confirmed: "已确认", inferred: "推断", missing: "缺失" }[confidence] ?? "未知";
}

function confidenceBadge(confidence) {
  return `<span class="confidence-badge is-${escapeHTML(confidence)}">${confidenceLabel(confidence)}</span>`;
}

function evidenceCounts(model) {
  return model.evidence.reduce((counts, item) => {
    counts[item.confidence] = (counts[item.confidence] ?? 0) + 1;
    return counts;
  }, { confirmed: 0, inferred: 0, missing: 0 });
}

function navCounts(model) {
  return {
    overview: `${Math.round(model.project.coverage * 100)}%`,
    worldview: model.worldview.cards.length,
    gameplay: model.coreGameplay.loopSteps.length + model.coreGameplay.rules.length,
    tuning: model.tuningParameters.length,
    preview: state.preview.active ? "LIVE" : "A/B",
    assets: model.assets.length,
    verification: state.receipts.length,
  };
}

function renderShell() {
  const model = state.model;
  const counts = navCounts(model);
  app.className = "app-shell";
  app.innerHTML = `
    <aside class="sidebar" aria-label="工作台导航">
      <div class="brand">
        <div class="brand__eyebrow">CODEX PLUGIN // THREE.JS</div>
        <div class="brand__name">游戏调优工作台 <span>GTW</span></div>
      </div>
      <div class="project-mini">
        <strong title="${escapeHTML(model.project.name)}">${escapeHTML(humanizeProjectName(model.project.name))}</strong>
        <span>THREE ${escapeHTML(model.project.detectedThreeVersion ?? "UNKNOWN")}</span>
      </div>
      <nav class="nav-list">
        ${Object.entries(VIEW_META).map(([id, meta]) => `
          <button type="button" class="nav-button${state.view === id ? " is-active" : ""}" data-view="${id}" aria-current="${state.view === id ? "page" : "false"}">
            <span class="nav-index">${meta.index}</span>
            <span>${meta.label}</span>
            <span class="nav-count">${counts[id]}</span>
          </button>
        `).join("")}
      </nav>
      <div class="sidebar__footer">
        <div class="mode-badge${isDraftMode() ? " is-draft" : ""}${isApplyMode() && state.applyStatus.enabled ? " is-apply" : ""}" data-mode-badge>${modeLabel()}</div>
        <p data-mode-note>${modeNote()}</p>
      </div>
    </aside>
    <main class="workspace">
      <header class="workspace-header">
        <div>
          <div class="section-kicker" data-view-kicker></div>
          <h1 data-view-title></h1>
        </div>
        <div class="workspace-actions">
          ${isDraftMode() ? `<button type="button" class="draft-counter" data-open-draft-summary><span>草稿</span><strong data-draft-count>${draftCount()}</strong></button>` : ""}
          <label class="search-box">
            <span>/</span>
            <input type="search" data-search placeholder="搜索当前工作区" autocomplete="off" aria-label="搜索当前工作区">
          </label>
        </div>
      </header>
      <div class="workspace-content" data-view-content></div>
    </main>
  `;
  bindShellEvents();
  renderView();
}

function bindShellEvents() {
  app.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.view = viewButton.dataset.view;
      state.query = "";
      app.querySelector("[data-search]").value = "";
      renderView();
      if (state.view === "verification") refreshReceipts().catch(showApplyError);
      if (state.view === "preview") loadRuntimePreviewStatus().then(renderViewContent).catch(showApplyError);
      return;
    }
    const filterButton = event.target.closest("[data-tuning-group]");
    if (filterButton) {
      state.tuningGroup = filterButton.dataset.tuningGroup;
      renderViewContent();
      return;
    }
    const editWorldviewButton = event.target.closest("[data-edit-worldview]");
    if (editWorldviewButton) {
      openWorldviewEditor(editWorldviewButton.dataset.editWorldview);
      return;
    }
    const editGameplayButton = event.target.closest("[data-edit-gameplay]");
    if (editGameplayButton) {
      openGameplayEditor(editGameplayButton.dataset.editGameplay);
      return;
    }
    const editAssetButton = event.target.closest("[data-edit-asset]");
    if (editAssetButton && !editAssetButton.disabled) {
      openAssetEditor(editAssetButton.dataset.editAsset);
      return;
    }
    const stepButton = event.target.closest("[data-draft-step]");
    if (stepButton) {
      const parameter = getParameter(stepButton.dataset.parameterId);
      if (!parameter) return;
      const direction = Number(stepButton.dataset.draftStep);
      setDraftValue(parameter, Number(currentDraftValue(parameter)) + Number(parameter.safeRange.step) * direction);
      renderViewContent();
      return;
    }
    const resetButton = event.target.closest("[data-reset-draft]");
    if (resetButton) {
      clearDraft(resetButton.dataset.resetDraft);
      renderViewContent();
      return;
    }
    if (event.target.closest("[data-discard-all-drafts]")) {
      openDiscardDraftsDialog();
      return;
    }
    if (event.target.closest("[data-propose-changeset]")) {
      proposeChangeSet().catch(showApplyError);
      return;
    }
    const revertButton = event.target.closest("[data-revert-receipt]");
    if (revertButton) {
      openRevertConfirmation(revertButton.dataset.revertReceipt);
      return;
    }
    const receiptButton = event.target.closest("[data-select-receipt]");
    if (receiptButton) {
      state.selectedReceiptId = receiptButton.dataset.selectReceipt;
      renderViewContent();
      return;
    }
    const saveVerificationButton = event.target.closest("[data-save-verification]");
    if (saveVerificationButton) {
      savePlaytest(saveVerificationButton.dataset.saveVerification, saveVerificationButton).catch(showApplyError);
      return;
    }
    const uploadEvidenceButton = event.target.closest("[data-upload-evidence]");
    if (uploadEvidenceButton) {
      uploadEvidence(uploadEvidenceButton).catch(showApplyError);
      return;
    }
    const startPreviewButton = event.target.closest("[data-start-preview]");
    if (startPreviewButton) {
      startRuntimePreview(startPreviewButton).catch(showApplyError);
      return;
    }
    const stopPreviewButton = event.target.closest("[data-stop-preview]");
    if (stopPreviewButton) {
      stopRuntimePreview(stopPreviewButton).catch(showApplyError);
      return;
    }
    const previewVariantButton = event.target.closest("[data-preview-variant]");
    if (previewVariantButton) {
      selectPreviewVariant(previewVariantButton.dataset.previewVariant);
      return;
    }
    const deleteEvidenceButton = event.target.closest("[data-delete-evidence]");
    if (deleteEvidenceButton) {
      openDeleteEvidenceConfirmation(deleteEvidenceButton.dataset.receiptId, deleteEvidenceButton.dataset.deleteEvidence);
      return;
    }
    if (event.target.closest("[data-confirm-discard-all]")) {
      state.drafts = {};
      persistDrafts();
      updateDraftChrome();
      dialog.close();
      renderViewContent();
      return;
    }
    if (event.target.closest("[data-preview-changeset], [data-open-draft-summary]")) {
      openDraftSummary();
      return;
    }
    if (event.target.closest("[data-download-changeset]")) {
      downloadDraftChangeSet();
      return;
    }
    if (event.target.closest("[data-copy-changeset]")) {
      copyDraftChangeSet(event.target.closest("[data-copy-changeset]")).catch(showApplyError);
      return;
    }
    const detailTarget = event.target.closest("[data-detail-kind][data-detail-id]");
    if (detailTarget) openDetail(detailTarget.dataset.detailKind, detailTarget.dataset.detailId);
  });

  app.querySelector("[data-search]").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderViewContent();
  });

  app.addEventListener("input", (event) => {
    if (!event.target.matches('input[type="range"][data-draft-param]')) return;
    updateDraftFromInput(event.target);
  });

  app.addEventListener("change", (event) => {
    if (!event.target.matches('input[type="number"][data-draft-param]')) return;
    updateDraftFromInput(event.target);
  });
}

function updateDraftChrome() {
  app.dataset.draftCount = String(draftCount());
  app.querySelectorAll("[data-draft-count]").forEach((node) => { node.textContent = String(draftCount()); });
  const badge = app.querySelector("[data-mode-badge]");
  const note = app.querySelector("[data-mode-note]");
  if (badge) badge.textContent = isDraftMode() && !isApplyMode() && draftCount() > 0 ? `浏览器草稿 · ${draftCount()} 项` : modeLabel();
  if (note) note.textContent = modeNote();
}

function updateDraftFromInput(input) {
  const parameter = getParameter(input.dataset.draftParam);
  if (!parameter) return;
  const after = setDraftValue(parameter, input.value);
  if (after === null) return;
  const card = input.closest("[data-parameter-card]");
  if (!card) return;
  card.classList.toggle("is-draft", hasDraft(parameter));
  card.querySelectorAll("[data-draft-param]").forEach((control) => { control.value = String(after); });
  card.querySelector("[data-draft-value]").textContent = formatNumber(after);
  card.querySelector("[data-draft-state]").textContent = hasDraft(parameter) ? "草稿已修改" : "原始值";
  card.querySelector("[data-draft-sense]").textContent = draftSense(parameter, after);
  card.querySelector("[data-reset-draft]").hidden = !hasDraft(parameter);
  const panel = app.querySelector("[data-draft-panel]");
  if (panel) panel.innerHTML = renderDraftPanelContent();
}

function renderView() {
  const meta = VIEW_META[state.view];
  app.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  app.querySelector("[data-view-kicker]").textContent = meta.kicker;
  app.querySelector("[data-view-title]").textContent = meta.label;
  const search = app.querySelector("[data-search]");
  search.disabled = new Set(["overview", "preview", "verification"]).has(state.view);
  search.placeholder = search.disabled ? "当前工作区无需搜索" : `搜索${meta.label}`;
  renderViewContent();
}

function renderViewContent() {
  const container = app.querySelector("[data-view-content]");
  const renderers = {
    overview: renderOverview,
    worldview: renderWorldview,
    gameplay: renderGameplay,
    tuning: renderTuning,
    preview: renderRuntimePreview,
    assets: renderAssets,
    verification: renderVerification,
  };
  container.innerHTML = renderers[state.view]();
}

function renderOverview() {
  const model = state.model;
  const counts = evidenceCounts(model);
  const limitations = model.project.limitations.length > 0
    ? model.project.limitations.map((item, index) => `<li><b>0${index + 1}</b><span>${escapeHTML(item)}</span></li>`).join("")
    : "<li><b>OK</b><span>当前分析没有记录额外限制。</span></li>";
  return `
    <section class="project-strip" aria-label="项目状态">
      <div>
        <div class="meta-label">CURRENT PROJECT</div>
        <h2>${escapeHTML(humanizeProjectName(model.project.name))}</h2>
        <p>${escapeHTML(model.project.entryPoints.join(" · "))} · ${escapeHTML(model.project.runtimeRoots.join(" · "))}</p>
      </div>
      <div><div class="meta-label">TUNING</div><strong>${model.tuningParameters.length}</strong><span>已确认参数</span></div>
      <div><div class="meta-label">RULES</div><strong>${model.coreGameplay.rules.length}</strong><span>运行时规则</span></div>
      <div><div class="meta-label">ASSETS</div><strong>${model.assets.length}</strong><span>素材槽位</span></div>
    </section>
    <div class="coverage-layout">
      <section class="coverage-panel">
        <div class="coverage-ring" style="--coverage:${model.project.coverage * 100}">
          <div><strong>${Math.round(model.project.coverage * 100)}%</strong><span>分析覆盖率</span></div>
        </div>
        <p class="coverage-note">这是源码分析覆盖率，不代表游戏质量或完整试玩验收。</p>
      </section>
      <section class="limitations-panel">
        <div class="panel-heading">
          <div><div class="section-kicker">KNOWN LIMITATIONS</div><h2>需要你确认的边界</h2></div>
          ${confidenceBadge("inferred")}
        </div>
        <ul class="limitation-list">${limitations}</ul>
        <div class="confidence-grid">
          <div class="confidence-cell"><div class="meta-label">CONFIRMED</div><strong>${counts.confirmed}</strong><span>有源码或运行时依据</span></div>
          <div class="confidence-cell"><div class="meta-label">INFERRED</div><strong>${counts.inferred}</strong><span>需要用户或试玩确认</span></div>
          <div class="confidence-cell"><div class="meta-label">MISSING</div><strong>${counts.missing}</strong><span>当前模型未定义</span></div>
        </div>
      </section>
    </div>
  `;
}

function matchesQuery(item, fields) {
  if (!state.query) return true;
  return fields.some((field) => String(item[field] ?? "").toLowerCase().includes(state.query));
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHTML(message)}</div>`;
}

function renderWorldview() {
  const cards = state.model.worldview.cards.filter((card) => matchesQuery(card, ["title", "body", "category", "id"]));
  return `
    <div class="section-stack">
      <section class="content-panel">
        <div class="panel-heading">
          <div>
            <div class="section-kicker">WORLDVIEW CARDS</div>
            <h2>图文世界设定</h2>
            <p>先区分已经写进项目的事实和 Codex 的推断。草稿只作用于当前卡片，并通过 ChangeSet 交给 Codex 实施。</p>
          </div>
          <span class="status-chip is-inferred">${cards.length} 张卡片</span>
        </div>
        <div class="card-grid">
          ${cards.length > 0 ? cards.map((card) => {
            const draft = state.drafts[card.id]?.type === "edit-worldview" ? state.drafts[card.id] : null;
            const visible = draft?.after ?? card;
            return `
            <article class="inspect-card${draft ? " is-draft" : ""}">
              <div class="card-body">
                <div class="card-topline"><code>${escapeHTML(card.category.toUpperCase())}</code>${draft ? '<span class="status-chip is-draft-status">草稿</span>' : confidenceBadge(card.confidence)}</div>
                <h3>${escapeHTML(visible.title)}</h3>
                <p>${escapeHTML(visible.body)}</p>
              </div>
              <div class="card-footer card-footer--actions"><span>${card.assetIds.length} 个关联素材</span><div><button type="button" class="text-button" data-detail-kind="worldview" data-detail-id="${escapeHTML(card.id)}">查看依据</button>${isDraftMode() ? `<button type="button" class="text-button is-accent" data-edit-worldview="${escapeHTML(card.id)}">${draft ? "继续修改" : "创建草稿"}</button>` : ""}</div></div>
            </article>
          `; }).join("") : emptyState("没有符合搜索条件的世界观卡片")}
        </div>
      </section>
    </div>
  `;
}

function renderGameplay() {
  const model = state.model;
  const steps = model.coreGameplay.loopSteps.filter((step) => matchesQuery(step, ["playerAction", "gameResponse", "reward", "risk", "id"]));
  const rules = model.coreGameplay.rules.filter((rule) => matchesQuery(rule, ["label", "trigger", "result", "playerFeedback", "id"]));
  return `
    <div class="section-stack">
      <section class="content-panel">
        <div class="panel-heading">
          <div><div class="section-kicker">PLAYER LOOP</div><h2>${escapeHTML(model.coreGameplay.summary)}</h2><p>用“玩家做什么 → 游戏如何回应 → 获得什么 → 承担什么风险”解释代码中的循环。</p></div>
          ${confidenceBadge(steps.every((step) => step.confidence === "confirmed") ? "confirmed" : "inferred")}
        </div>
        ${steps.length > 0 ? `
          <div class="loop-lane" style="--steps:${steps.length}">
            ${steps.map((step) => `
              <article class="loop-step">
                <span class="loop-step__index">STEP ${String(step.order).padStart(2, "0")}</span>
                <h3>${escapeHTML(step.playerAction)}</h3>
                <p>${escapeHTML(step.gameResponse)}</p>
                <dl><dt>得到</dt><dd>${escapeHTML(step.reward)}</dd><dt>风险</dt><dd>${escapeHTML(step.risk)}</dd></dl>
              </article>
            `).join("")}
          </div>
        ` : emptyState("没有符合搜索条件的核心循环步骤")}
      </section>
      <section class="content-panel">
        <div class="panel-heading">
          <div><div class="section-kicker">CONSUMED RULES</div><h2>运行时玩法规则</h2><p>这里只显示已经注册并被生产源码消费的事件关系；每条规则可单独形成玩法意图草稿。</p></div>
          <span class="status-chip is-confirmed">${rules.length} 条规则</span>
        </div>
        <div class="rule-list">
          ${rules.length > 0 ? rules.map((rule) => {
            const draft = state.drafts[rule.id]?.type === "edit-gameplay" ? state.drafts[rule.id] : null;
            const visible = draft?.after ?? rule;
            return `
            <article class="rule-row${draft ? " is-draft" : ""}">
              <code>${escapeHTML(rule.ownerId)}</code>
              <strong>${escapeHTML(visible.trigger)}</strong>
              <span class="rule-arrow">→</span>
              <span>${escapeHTML(visible.result)}</span>
              ${draft ? '<span class="status-chip is-draft-status">草稿</span>' : confidenceBadge(rule.confidence)}
              <div class="row-actions"><button type="button" class="text-button" data-detail-kind="rule" data-detail-id="${escapeHTML(rule.id)}">依据</button>${isDraftMode() ? `<button type="button" class="text-button is-accent" data-edit-gameplay="${escapeHTML(rule.id)}">${draft ? "修改" : "调玩法"}</button>` : ""}</div>
            </article>
          `; }).join("") : emptyState("没有符合搜索条件的运行时规则")}
        </div>
      </section>
    </div>
  `;
}

function parameterPosition(parameter) {
  const range = parameter.safeRange;
  const value = currentDraftValue(parameter);
  if (!range || !Number.isFinite(Number(value)) || range.max === range.min) return 50;
  return Math.max(0, Math.min(100, ((Number(value) - range.min) / (range.max - range.min)) * 100));
}

function renderTuning() {
  return isDraftMode() ? renderDraftTuning() : renderReadonlyTuning();
}

function tuningGroups(allParameters) {
  return [...new Set(allParameters.map((parameter) => parameter.group))];
}

function filteredParameters(allParameters) {
  return allParameters.filter((parameter) => {
    const groupMatches = state.tuningGroup === "all" || parameter.group === state.tuningGroup;
    return groupMatches && matchesQuery(parameter, ["label", "description", "id", "ownerId", "group"]);
  });
}

function renderTuningFilters(allParameters) {
  const groups = tuningGroups(allParameters);
  return `
    <div class="filter-row" aria-label="参数分组">
      <button type="button" class="filter-button${state.tuningGroup === "all" ? " is-active" : ""}" data-tuning-group="all">全部 ${allParameters.length}</button>
      ${groups.map((group) => {
        const count = allParameters.filter((parameter) => parameter.group === group).length;
        return `<button type="button" class="filter-button${state.tuningGroup === group ? " is-active" : ""}" data-tuning-group="${escapeHTML(group)}">${escapeHTML(GROUP_LABELS[group] ?? group)} ${count}</button>`;
      }).join("")}
    </div>
  `;
}

function renderReadonlyTuning() {
  const allParameters = state.model.tuningParameters;
  const parameters = filteredParameters(allParameters);
  return `
    <section class="content-panel">
      <div class="panel-heading">
        <div><div class="section-kicker">READ-ONLY PARAMETERS</div><h2>普通人能理解的数值</h2><p>刻度只展示当前值和安全范围。此阶段没有滑杆、保存或应用操作。</p></div>
        <span class="status-chip is-confirmed">${allParameters.length} 个已绑定</span>
      </div>
      ${renderTuningFilters(allParameters)}
      <div class="parameter-grid">
        ${parameters.length > 0 ? parameters.map((parameter) => {
          const range = parameter.safeRange;
          const unit = parameter.unit ? ` ${escapeHTML(parameter.unit)}` : "";
          return `
            <button type="button" class="parameter-card" data-detail-kind="parameter" data-detail-id="${escapeHTML(parameter.id)}">
              <div class="parameter-card__title"><h3>${escapeHTML(parameter.label)}</h3><span class="parameter-value">${formatNumber(parameter.currentValue)}${unit}</span></div>
              <p class="parameter-card__description">${escapeHTML(parameter.description)}</p>
              <span class="parameter-owner">${escapeHTML(GROUP_LABELS[parameter.group] ?? parameter.group)} · ${escapeHTML(parameter.ownerId)}</span>
              ${range ? `
                <div class="range-visual" aria-label="当前值在安全范围中的位置"><span class="range-visual__fill" style="--position:${parameterPosition(parameter)}%"></span></div>
                <div class="range-labels"><span>${formatNumber(range.min)}</span><span>安全范围</span><span>${formatNumber(range.max)}</span></div>
              ` : ""}
              <div class="parameter-meaning"><span>降低：${escapeHTML(parameter.playerMeaning.lower)}</span><span>提高：${escapeHTML(parameter.playerMeaning.higher)}</span></div>
            </button>
          `;
        }).join("") : emptyState("没有符合筛选条件的参数")}
      </div>
    </section>
  `;
}

function draftSense(parameter, value) {
  if (value === parameter.currentValue) return "保持原始平衡";
  return value < parameter.currentValue
    ? `更偏向：${parameter.playerMeaning.lower}`
    : `更偏向：${parameter.playerMeaning.higher}`;
}

function draftDelta(parameter) {
  const value = currentDraftValue(parameter);
  const delta = Number(value) - Number(parameter.currentValue);
  if (delta === 0) return "0";
  return `${delta > 0 ? "+" : ""}${formatNumber(delta)}`;
}

function renderDraftParameter(parameter) {
  const range = parameter.safeRange;
  const value = currentDraftValue(parameter);
  const unit = parameter.unit ? ` ${escapeHTML(parameter.unit)}` : "";
  const dirty = hasDraft(parameter);
  return `
    <article class="parameter-card parameter-card--editable${dirty ? " is-draft" : ""}" data-parameter-card data-parameter-id="${escapeHTML(parameter.id)}">
      <div class="parameter-card__title">
        <div><h3>${escapeHTML(parameter.label)}</h3><span class="parameter-owner">${escapeHTML(GROUP_LABELS[parameter.group] ?? parameter.group)} · ${escapeHTML(parameter.ownerId)}</span></div>
        <span class="draft-state${dirty ? " is-active" : ""}" data-draft-state>${dirty ? "草稿已修改" : "原始值"}</span>
      </div>
      <p class="parameter-card__description">${escapeHTML(parameter.description)}</p>
      <div class="draft-values" aria-label="原值与草稿值对比">
        <div><span>原值</span><strong>${formatNumber(parameter.currentValue)}${unit}</strong></div>
        <span class="draft-values__arrow">→</span>
        <div><span>草稿</span><strong><span data-draft-value>${formatNumber(value)}</span>${unit}</strong><small>${dirty ? draftDelta(parameter) : "未修改"}</small></div>
      </div>
      ${range ? `
        <div class="draft-control">
          <button type="button" class="step-button" data-draft-step="-1" data-parameter-id="${escapeHTML(parameter.id)}" aria-label="降低${escapeHTML(parameter.label)}">−</button>
          <input type="range" min="${range.min}" max="${range.max}" step="${range.step}" value="${value}" data-draft-param="${escapeHTML(parameter.id)}" aria-label="调整${escapeHTML(parameter.label)}">
          <button type="button" class="step-button" data-draft-step="1" data-parameter-id="${escapeHTML(parameter.id)}" aria-label="提高${escapeHTML(parameter.label)}">＋</button>
        </div>
        <div class="range-labels"><span>${formatNumber(range.min)}</span><span>安全范围 · 步进 ${formatNumber(range.step)}</span><span>${formatNumber(range.max)}</span></div>
        <div class="draft-precision-row">
          <label>精确值 <input type="number" min="${range.min}" max="${range.max}" step="${range.step}" value="${value}" data-draft-param="${escapeHTML(parameter.id)}" aria-label="输入${escapeHTML(parameter.label)}草稿值"></label>
          <div>
            <button type="button" class="text-button" data-detail-kind="parameter" data-detail-id="${escapeHTML(parameter.id)}">查看依据</button>
            <button type="button" class="text-button is-warning" data-reset-draft="${escapeHTML(parameter.id)}"${dirty ? "" : " hidden"}>恢复原值</button>
          </div>
        </div>
      ` : `<div class="draft-unavailable">缺少安全范围，暂不开放草稿调节。</div>`}
      <div class="draft-sense" data-draft-sense>${escapeHTML(draftSense(parameter, value))}</div>
      <div class="impact-boundary">
        <div><span>只影响</span><p>${escapeHTML(parameter.effects.direct.join("；") || "当前数值绑定")}</p></div>
        <div><span>保持不变</span><p>${escapeHTML(parameter.effects.excluded.join("；") || "没有记录排除项")}</p></div>
      </div>
    </article>
  `;
}

function renderDraftTuning() {
  const allParameters = state.model.tuningParameters;
  const parameters = filteredParameters(allParameters);
  return `
    <div class="draft-workspace">
      <section class="content-panel draft-parameter-panel">
        <div class="panel-heading">
          <div><div class="section-kicker">${isApplyMode() ? "CONFIRMABLE PARAMETERS" : "LOCAL DRAFT PARAMETERS"}</div><h2>${isApplyMode() ? "先形成草稿，再单独确认写入" : "先试着调，不会改源码"}</h2><p>每张卡片只记录一个参数。移动滑杆后，右侧会生成原值对比和独立影响清单。</p></div>
          <span class="status-chip is-draft-status"><span data-draft-count>${draftCount()}</span> 项草稿</span>
        </div>
        ${renderTuningFilters(allParameters)}
        <div class="parameter-grid parameter-grid--draft">
          ${parameters.length > 0 ? parameters.map(renderDraftParameter).join("") : emptyState("没有符合筛选条件的参数")}
        </div>
      </section>
      <aside class="draft-panel" data-draft-panel aria-label="当前草稿清单">${renderDraftPanelContent()}</aside>
    </div>
  `;
}

function renderReceiptPanel() {
  const receipt = state.receipt;
  if (!receipt) return "";
  const reverted = receipt.state === "reverted";
  const failed = receipt.state === "failed";
  return `
    <section class="apply-receipt is-${escapeHTML(receipt.state)}">
      <span>${reverted ? "已撤销" : failed ? "构建失败" : "已写入源码"}</span>
      <strong>${receipt.changeSet.operations.length} 项参数</strong>
      <p>${reverted ? "记录中的原值已恢复。" : failed ? "源码已修改，但构建未通过；建议立即撤销或检查错误。" : "构建状态已记录，仍需完成真实试玩验证。"}</p>
      ${!reverted ? `<button type="button" class="secondary-button" data-revert-receipt="${escapeHTML(receipt.receiptId)}">撤销本次应用</button>` : ""}
    </section>
  `;
}

function draftPresentation(draft) {
  const type = draft.type ?? "set-parameter";
  if (type === "set-parameter") {
    const parameter = getParameter(draft.targetId);
    const unit = parameter?.unit ? ` ${escapeHTML(parameter.unit)}` : "";
    return {
      label: parameter?.label ?? draft.targetId,
      typeLabel: "数值 · 自动应用",
      change: `${formatNumber(draft.before)}${unit} → ${formatNumber(draft.after)}${unit}`,
      detail: parameter?.effects?.direct?.join("；") ?? draft.reason,
    };
  }
  if (type === "edit-worldview") {
    const card = getWorldviewCard(draft.targetId);
    return { label: card?.title ?? draft.targetId, typeLabel: "世界观 · Codex 辅助", change: `${draft.before.title} → ${draft.after.title}`, detail: draft.after.body };
  }
  if (type === "edit-gameplay") {
    const rule = getGameplayRule(draft.targetId);
    return { label: rule?.label ?? draft.targetId, typeLabel: "玩法规则 · Codex 辅助", change: `${draft.after.trigger} → ${draft.after.result}`, detail: draft.after.playerFeedback };
  }
  const asset = getAsset(draft.targetId);
  return { label: asset?.label ?? draft.targetId, typeLabel: "素材 · Codex 辅助", change: "当前素材 → 待生成候选", detail: draft.after.generationRequest.prompt };
}

function renderDraftPanelContent() {
  const entries = draftEntries();
  const automaticCount = parameterDraftCount();
  const assistedCount = assistedDraftEntries().length;
  const proposalAvailable = isApplyMode() && state.applyStatus.proposalEnabled;
  const applyAvailable = isApplyMode() && state.applyStatus.enabled;
  return `
    <div class="draft-panel__heading">
      <div><div class="section-kicker">DRAFT CHANGESET</div><h2>当前草稿</h2></div>
      <span class="draft-count-pill"><span data-draft-count>${entries.length}</span> 项</span>
    </div>
    ${renderReceiptPanel()}
    <div class="draft-safety-note"><strong>${applyAvailable ? "写入前安全检查" : "源码未修改"}</strong><span>${applyAvailable ? "确认时会复核项目根目录、源码行、原值和摘要指纹。" : "这里只保存当前浏览器里的预览值。"}</span></div>
    ${entries.length > 0 ? `
      <ol class="draft-list">
        ${entries.map((draft) => {
          const presentation = draftPresentation(draft);
          return `<li><div><strong>${escapeHTML(presentation.label)}</strong><span>${escapeHTML(presentation.change)}</span><small>${escapeHTML(presentation.typeLabel)}</small></div><button type="button" data-reset-draft="${escapeHTML(draft.targetId)}" aria-label="撤销${escapeHTML(presentation.label)}草稿">撤销</button><p>${escapeHTML(presentation.detail)}</p></li>`;
        }).join("")}
      </ol>
      <div class="draft-boundary-summary"><span>独立性保护</span><p>${automaticCount} 项精确值草稿可由本地引擎应用；${assistedCount} 项语义草稿只交给 Codex 审查，不会混入自动写入。</p></div>
    ` : `<div class="draft-empty"><strong>还没有草稿</strong><p>可从世界观、玩法规则、数值或素材页创建一项独立草稿。</p></div>`}
    <div class="draft-panel__actions">
      ${isApplyMode() ? `<button type="button" class="secondary-button" data-start-preview${automaticCount === 0 || !state.applyStatus.runtimePreviewEnabled ? " disabled" : ""}>${state.preview.active ? "更新数值 A/B 试玩" : "启动数值 A/B 试玩"}</button>` : ""}
      ${isApplyMode()
        ? `<button type="button" class="primary-button" data-propose-changeset${automaticCount === 0 || !proposalAvailable ? " disabled" : ""}>检查 ${automaticCount} 项自动应用</button>`
        : `<button type="button" class="primary-button" data-preview-changeset${entries.length === 0 ? " disabled" : ""}>预览确认单</button>`}
      <button type="button" class="secondary-button" data-download-changeset${entries.length === 0 ? " disabled" : ""}>下载完整 ChangeSet</button>
      <button type="button" class="secondary-button" data-discard-all-drafts${entries.length === 0 ? " disabled" : ""}>全部放弃</button>
    </div>
    <p class="draft-next-step">${isApplyMode()
      ? applyAvailable ? "精确数值走本地二次确认；世界观、规则和素材通过完整 ChangeSet 交给 Codex 实施。" : proposalAvailable ? "安全预览：可以检查数值确认单，语义草稿仍可下载。" : "安全锁定：本地服务无法校验当前项目。"
      : "下一阶段才会提供“确认应用”。当前按钮不会写入游戏文件。"}</p>
  `;
}

function previewMatchesDraft() {
  if (!state.preview.active || !state.preview.session?.changeSet) return false;
  const previewValues = new Map(state.preview.session.changeSet.operations.map((operation) => [operation.targetId, operation.after]));
  const entries = parameterDraftEntries();
  return entries.length === previewValues.size && entries.every((entry) => previewValues.get(entry.targetId) === entry.after);
}

function renderRuntimePreview() {
  if (!isApplyMode()) {
    return `<section class="content-panel">${emptyState("A/B 试玩只在确认应用工作台中开放。")}</section>`;
  }
  if (!state.applyStatus.runtimePreviewEnabled) {
    return `<section class="content-panel preview-guide"><div class="section-kicker">RUNTIME PREVIEW UNAVAILABLE</div><h2>当前项目不能启动运行时预览</h2><p>目标项目需要可访问的 package.json，以及 dev 或 start 脚本。</p></section>`;
  }
  const session = state.preview.session;
  if (!state.preview.active || !session) {
    return `
      <section class="content-panel preview-guide">
        <div class="section-kicker">TEMPORARY A/B RUNTIME</div>
        <h2>用真实游戏比较原值与草稿</h2>
        <p>工作台会在系统临时目录创建两份运行副本：A 保留当前源码参数，B 只在临时副本中写入草稿参数。关闭预览后临时副本会删除，目标项目源码不变。</p>
        <div class="preview-contract-grid"><div><strong>A</strong><span>当前源码参数</span></div><div><strong>B</strong><span>浏览器草稿参数</span></div><div><strong>0</strong><span>目标源码写入</span></div></div>
        ${parameterDraftCount() > 0 ? `<div class="preview-draft-list"><h3>准备比较 ${parameterDraftCount()} 项数值草稿</h3><ul>${parameterDraftEntries().map((draft) => { const parameter = getParameter(draft.targetId); return `<li><strong>${escapeHTML(parameter?.label ?? draft.targetId)}</strong><span>${formatNumber(draft.before)} → ${formatNumber(draft.after)}</span></li>`; }).join("")}</ul></div>` : `<div class="empty-evidence">先到“数值调优”修改至少一个参数，再启动 A/B 试玩。世界观、规则和素材草稿需要由 Codex 实施后再试玩。</div>`}
        <button type="button" class="primary-button" data-start-preview${parameterDraftCount() === 0 ? " disabled" : ""}>启动 A/B 试玩</button>
      </section>`;
  }
  const current = previewMatchesDraft();
  return `
    <section class="runtime-preview-shell">
      <div class="runtime-preview-toolbar">
        <div><div class="section-kicker">${escapeHTML(session.sessionId)}</div><h2>A/B 真实试玩</h2><p>${session.operationCount} 项参数 · ${current ? "当前草稿已同步" : "草稿已变化，需要更新预览"}</p></div>
        <div class="runtime-preview-safety ${state.preview.sourceUnchanged ? "is-safe" : "is-warning"}"><strong>${state.preview.sourceUnchanged ? "目标源码未修改" : "检测到目标源码变化"}</strong><span>预览仅运行临时副本</span></div>
        <div class="runtime-preview-actions"><button type="button" class="secondary-button" data-start-preview${parameterDraftCount() === 0 ? " disabled" : ""}>${current ? "重新启动" : "更新草稿预览"}</button><button type="button" class="danger-button" data-stop-preview>停止并清理</button></div>
      </div>
      <div class="preview-switcher" role="tablist" aria-label="A/B 试玩版本">
        <button type="button" role="tab" aria-selected="${state.previewVariant === "baseline"}" class="${state.previewVariant === "baseline" ? "is-active" : ""}" data-preview-variant="baseline"><strong>A</strong><span>原始参数</span></button>
        <button type="button" role="tab" aria-selected="${state.previewVariant === "draft"}" class="${state.previewVariant === "draft" ? "is-active" : ""}" data-preview-variant="draft"><strong>B</strong><span>草稿参数</span></button>
      </div>
      <div class="runtime-preview-stage">
        <iframe class="preview-frame${state.previewVariant === "baseline" ? " is-active" : ""}" data-preview-frame="baseline" src="${escapeHTML(session.baselineUrl)}" title="A 原始参数游戏预览" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" allow="fullscreen"></iframe>
        <iframe class="preview-frame${state.previewVariant === "draft" ? " is-active" : ""}" data-preview-frame="draft" src="${escapeHTML(session.draftUrl)}" title="B 草稿参数游戏预览" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" allow="fullscreen"></iframe>
      </div>
      <div class="runtime-preview-tips"><strong>比较方法</strong><span>在 A 中完成一小段固定操作，再切到 B 重复同样操作。涉及“重开生效”的参数，需要分别重新开始两边的游戏。</span></div>
    </section>`;
}

function selectPreviewVariant(variant) {
  if (!new Set(["baseline", "draft"]).has(variant)) return;
  state.previewVariant = variant;
  app.querySelectorAll("[data-preview-variant]").forEach((button) => {
    const active = button.dataset.previewVariant === variant;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  app.querySelectorAll("[data-preview-frame]").forEach((frame) => frame.classList.toggle("is-active", frame.dataset.previewFrame === variant));
}

async function startRuntimePreview(button) {
  if (parameterDraftCount() === 0) throw new Error("先修改至少一个数值参数，再启动 A/B 试玩。");
  button.disabled = true;
  button.textContent = "正在创建 A/B 临时副本…";
  const preview = await requestJson("./api/preview/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changeSet: proposedDraftChangeSet() }),
  });
  state.preview = preview;
  state.previewVariant = "baseline";
  state.view = "preview";
  renderShell();
}

async function stopRuntimePreview(button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = "正在清理…";
  }
  state.preview = await requestJson("./api/preview/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (state.view === "preview") renderViewContent();
  const count = app.querySelector('[data-view="preview"] .nav-count');
  if (count) count.textContent = "A/B";
}

async function loadRuntimePreviewStatus() {
  if (!isApplyMode() || !state.applyStatus.runtimePreviewEnabled) return;
  state.preview = await requestJson("./api/preview/status");
}

function safePreviewPath(preview) {
  if (!preview) return null;
  if (/^(\.\/)?media\/[a-zA-Z0-9._/-]+$/.test(preview) || /^data:image\//.test(preview)) return preview;
  return null;
}

function renderAssets() {
  const assets = state.model.assets.filter((asset) => matchesQuery(asset, ["label", "category", "slot", "id"]));
  return `
    <section class="content-panel">
      <div class="panel-heading">
        <div><div class="section-kicker">ASSET INVENTORY</div><h2>游戏素材槽位</h2><p>可为单个槽位准备第三方生成请求；服务和候选结果确认前，不会替换任何素材。</p></div>
        <span class="status-chip is-confirmed">${state.model.assets.length} 个槽位</span>
      </div>
      <div class="asset-grid">
        ${assets.length > 0 ? assets.map((asset) => {
          const preview = safePreviewPath(asset.preview);
          const procedural = asset.technicalContract.kind === "generated-runtime";
          const draft = state.drafts[asset.id]?.type === "replace-asset" ? state.drafts[asset.id] : null;
          const supported = asset.category !== "audio";
          return `
            <article class="asset-card${draft ? " is-draft" : ""}">
              <div class="asset-preview">
                ${preview ? `<img src="${escapeHTML(preview)}" alt="${escapeHTML(asset.label)}预览">` : `
                  <div class="asset-preview__placeholder"><strong>${procedural ? "PROC" : "FILE"}</strong><span>${procedural ? "运行时代码生成" : "暂无安全预览"}</span></div>
                `}
              </div>
              <div class="asset-card__body">
                <div class="card-topline"><code>${escapeHTML(CATEGORY_LABELS[asset.category] ?? asset.category)}</code>${draft ? '<span class="status-chip is-draft-status">素材草稿</span>' : confidenceBadge(asset.confidence)}</div>
                <h3>${escapeHTML(asset.label)}</h3>
                <p title="${escapeHTML(asset.source.file)}">${escapeHTML(asset.source.file)}</p>
                ${draft ? `<p class="asset-draft-prompt">${escapeHTML(draft.after.generationRequest.prompt)}</p>` : ""}
                <div class="row-actions"><button type="button" class="text-button" data-detail-kind="asset" data-detail-id="${escapeHTML(asset.id)}">约束</button>${isDraftMode() ? `<button type="button" class="text-button is-accent" data-edit-asset="${escapeHTML(asset.id)}"${supported ? "" : " disabled"}>${supported ? (draft ? "修改方案" : "生成方案") : "暂不支持音频"}</button>` : ""}</div>
              </div>
            </article>
          `;
        }).join("") : emptyState("没有符合搜索条件的素材槽位")}
      </div>
    </section>
  `;
}

function formatDateTime(value) {
  if (!value) return "尚未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHTML(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function receiptStateLabel(receipt) {
  const labels = {
    proposed: "待应用",
    applied: "待试玩验证",
    verified: "验证通过",
    failed: "验证失败",
    reverted: "已撤销",
  };
  return labels[receipt.state] ?? receipt.state;
}

function selectedReceipt() {
  return state.receipts.find((receipt) => receipt.receiptId === state.selectedReceiptId) ?? state.receipts[0] ?? null;
}

function renderVerification() {
  if (!isApplyMode()) {
    return `<section class="content-panel">${emptyState("验证与撤销只在确认应用工作台中开放。")}</section>`;
  }
  const receipt = selectedReceipt();
  return `
    <div class="verification-workspace">
      <aside class="receipt-history" aria-label="应用记录">
        <div class="panel-heading"><div><div class="section-kicker">APPLICATION HISTORY</div><h2>应用记录</h2><p>每次确认写入形成一条独立记录。</p></div><span class="status-chip">${state.receipts.length} 条</span></div>
        ${state.receipts.length > 0 ? `<div class="receipt-history__list">${state.receipts.map((item) => `
          <button type="button" class="receipt-history__item${receipt?.receiptId === item.receiptId ? " is-active" : ""}" data-select-receipt="${escapeHTML(item.receiptId)}">
            <span class="receipt-state is-${escapeHTML(item.state)}">${escapeHTML(receiptStateLabel(item))}</span>
            <strong>${escapeHTML(item.changeSet.summary)}</strong>
            <small>${formatDateTime(item.appliedAt)} · ${item.changeSet.operations.length} 项参数</small>
          </button>`).join("")}</div>` : emptyState(state.applyStatus.enabled ? "还没有应用记录。先确认应用一份参数草稿。" : "安全预览没有可管理的应用记录；启用精确项目授权后才会产生记录。")}
      </aside>
      <section class="verification-detail">${receipt ? renderVerificationReceipt(receipt) : renderVerificationGuide()}</section>
    </div>
  `;
}

function renderVerificationGuide() {
  return `
    <section class="content-panel verification-guide">
      <div class="section-kicker">VERIFICATION CONTRACT</div>
      <h2>构建通过不等于手感正确</h2>
      <p>应用后，工作台会根据预期影响和明确排除项生成试玩清单。完成真实试玩、添加截图并逐项判断后，记录才能成为“验证通过”。</p>
      <ol><li>启动目标游戏并进入受影响场景。</li><li>逐项检查变化是否符合预期。</li><li>确认不应变化的系统保持不变。</li><li>上传至少一张截图，再保存验证结论。</li></ol>
    </section>`;
}

function renderVerificationReceipt(receipt) {
  const playtest = receipt.playtest ?? { status: "not-run", checks: [], evidence: [], notes: "" };
  const mutable = state.applyStatus.enabled && receipt.state !== "reverted";
  const build = receipt.verification ?? { status: "not-run" };
  return `
    <section class="content-panel verification-record">
      <div class="panel-heading">
        <div><div class="section-kicker">${escapeHTML(receipt.receiptId)}</div><h2>${escapeHTML(receipt.changeSet.summary)}</h2><p>${formatDateTime(receipt.appliedAt)} · ${receipt.files.length} 个源码文件</p></div>
        <span class="receipt-state is-${escapeHTML(receipt.state)}">${escapeHTML(receiptStateLabel(receipt))}</span>
      </div>
      <div class="verification-summary-grid">
        <div><span>构建检查</span><strong class="is-${escapeHTML(build.status)}">${escapeHTML(build.status)}</strong></div>
        <div><span>试玩检查</span><strong>${playtest.checks.filter((check) => check.status === "passed").length} / ${playtest.checks.length}</strong></div>
        <div><span>截图证据</span><strong>${playtest.evidence.length}</strong></div>
        <div><span>最终状态</span><strong>${escapeHTML(receiptStateLabel(receipt))}</strong></div>
      </div>
      <section class="verification-section">
        <div class="verification-section__heading"><div><h3>试玩检查清单</h3><p>“符合预期”和“保持不变”必须分别验证。</p></div></div>
        <div class="playtest-checklist">
          ${playtest.checks.map((check, index) => `
            <article class="playtest-check is-${escapeHTML(check.status)}" data-playtest-check data-check-id="${escapeHTML(check.checkId)}">
              <div class="playtest-check__index">${String(index + 1).padStart(2, "0")}</div>
              <div><span>${check.kind === "excluded-effect" ? "保持不变" : "预期变化"}</span><h4>${escapeHTML(check.label)}</h4><p>${escapeHTML(check.description)}</p>
                <input type="text" value="${escapeHTML(check.notes)}" placeholder="可选：记录实际感受或异常" data-check-notes ${mutable ? "" : "disabled"}>
              </div>
              <select data-check-status aria-label="${escapeHTML(check.label)}的检查结果" ${mutable ? "" : "disabled"}>
                <option value="not-run"${check.status === "not-run" ? " selected" : ""}>未检查</option>
                <option value="passed"${check.status === "passed" ? " selected" : ""}>通过</option>
                <option value="failed"${check.status === "failed" ? " selected" : ""}>失败</option>
              </select>
            </article>`).join("")}
        </div>
      </section>
      <section class="verification-section">
        <div class="verification-section__heading"><div><h3>截图证据</h3><p>支持 PNG、JPEG、WebP，单张不超过 8 MB。</p></div></div>
        ${playtest.evidence.length > 0 ? `<div class="evidence-grid">${playtest.evidence.map((evidence) => `
          <figure class="evidence-card"><img src="./api/receipts/${encodeURIComponent(receipt.receiptId)}/evidence/${encodeURIComponent(evidence.evidenceId)}" alt="${escapeHTML(evidence.label)}"><figcaption><strong>${escapeHTML(evidence.label)}</strong><span>${formatDateTime(evidence.capturedAt)}</span>${mutable ? `<button type="button" data-delete-evidence="${escapeHTML(evidence.evidenceId)}" data-receipt-id="${escapeHTML(receipt.receiptId)}">删除</button>` : ""}</figcaption></figure>`).join("")}</div>` : `<div class="empty-evidence">尚未添加截图；没有截图时不能标记为验证通过。</div>`}
        ${mutable ? `<div class="evidence-upload"><input type="text" data-evidence-label placeholder="截图说明，例如：行走速度 A/B 对比"><input type="file" data-evidence-file accept="image/png,image/jpeg,image/webp"><button type="button" class="secondary-button" data-upload-evidence data-receipt-id="${escapeHTML(receipt.receiptId)}">添加截图</button></div>` : ""}
      </section>
      <section class="verification-section">
        <label class="verification-notes">整体验证备注<textarea data-playtest-notes rows="3" ${mutable ? "" : "disabled"} placeholder="记录测试场景、操作方式和总体判断">${escapeHTML(playtest.notes)}</textarea></label>
        ${mutable ? `<div class="verification-actions"><button type="button" class="secondary-button" data-save-verification="not-run" data-receipt-id="${escapeHTML(receipt.receiptId)}">保存进度</button><button type="button" class="danger-button" data-save-verification="failed" data-receipt-id="${escapeHTML(receipt.receiptId)}">记录失败</button><button type="button" class="primary-button" data-save-verification="passed" data-receipt-id="${escapeHTML(receipt.receiptId)}">标记验证通过</button><button type="button" class="secondary-button" data-revert-receipt="${escapeHTML(receipt.receiptId)}">撤销本次应用</button></div>` : ""}
      </section>
    </section>`;
}

function replaceReceipt(receipt) {
  const index = state.receipts.findIndex((item) => item.receiptId === receipt.receiptId);
  if (index >= 0) state.receipts[index] = receipt;
  else state.receipts.unshift(receipt);
  state.receipt = receipt;
  state.selectedReceiptId = receipt.receiptId;
}

async function refreshReceipts() {
  if (!isApplyMode()) return;
  const receipts = await requestJson("./api/receipts");
  state.receipts = receipts;
  if (!state.selectedReceiptId || !receipts.some((receipt) => receipt.receiptId === state.selectedReceiptId)) {
    state.selectedReceiptId = receipts[0]?.receiptId ?? null;
  }
  if (state.view === "verification") renderViewContent();
  const count = app.querySelector('[data-view="verification"] .nav-count');
  if (count) count.textContent = String(receipts.length);
}

function collectPlaytestForm() {
  const checks = [...app.querySelectorAll("[data-playtest-check]")].map((row) => ({
    checkId: row.dataset.checkId,
    status: row.querySelector("[data-check-status]").value,
    notes: row.querySelector("[data-check-notes]").value,
  }));
  return { checks, notes: app.querySelector("[data-playtest-notes]")?.value ?? "" };
}

async function savePlaytest(status, button) {
  const receiptId = button.dataset.receiptId;
  button.disabled = true;
  const payload = { ...collectPlaytestForm(), status };
  const receipt = await requestJson(`./api/receipts/${encodeURIComponent(receiptId)}/verification`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  replaceReceipt(receipt);
  renderViewContent();
}

function fileAsDataUrl(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolvePromise(reader.result));
    reader.addEventListener("error", () => rejectPromise(new Error("无法读取截图文件。")));
    reader.readAsDataURL(file);
  });
}

async function uploadEvidence(button) {
  const receiptId = button.dataset.receiptId;
  const file = app.querySelector("[data-evidence-file]")?.files?.[0];
  const labelInput = app.querySelector("[data-evidence-label]");
  if (!file) throw new Error("请先选择一张截图。");
  if (file.size > 8 * 1024 * 1024) throw new Error("截图不能超过 8 MB。");
  button.disabled = true;
  button.textContent = "正在添加…";
  const receipt = await requestJson(`./api/receipts/${encodeURIComponent(receiptId)}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: labelInput?.value.trim() || file.name, dataUrl: await fileAsDataUrl(file) }),
  });
  replaceReceipt(receipt);
  renderViewContent();
}

function openDeleteEvidenceConfirmation(receiptId, evidenceId) {
  openDialog("DELETE SCREENSHOT EVIDENCE", "删除这张截图？", `
    <section class="detail-section"><p>这只会删除当前应用记录中的截图证据，不会修改游戏源码。</p></section>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-cancel>保留截图</button><button type="button" class="danger-button" data-confirm-delete-evidence="${escapeHTML(evidenceId)}" data-receipt-id="${escapeHTML(receiptId)}">确认删除</button></div>`);
}

async function deleteEvidence(receiptId, evidenceId, button) {
  button.disabled = true;
  const receipt = await requestJson(`./api/receipts/${encodeURIComponent(receiptId)}/evidence/${encodeURIComponent(evidenceId)}`, { method: "DELETE" });
  replaceReceipt(receipt);
  dialog.close();
  renderViewContent();
}

function findDetail(kind, id) {
  const model = state.model;
  const sources = {
    worldview: model.worldview.cards,
    rule: model.coreGameplay.rules,
    parameter: model.tuningParameters,
    asset: model.assets,
  };
  return sources[kind]?.find((item) => item.id === id) ?? null;
}

function listSection(title, items) {
  if (!items?.length) return "";
  return `<section class="detail-section"><h3>${escapeHTML(title)}</h3><ul>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul></section>`;
}

function bindingText(binding) {
  if (!binding) return "未提供";
  return [binding.file, binding.symbol, binding.lineHint ? `line ${binding.lineHint}` : null, binding.access].filter(Boolean).join(" · ");
}

function renderDetail(kind, item) {
  const common = `
    <section class="detail-section"><h3>模型状态</h3><p>${confidenceBadge(item.confidence)} <code>${escapeHTML(item.id)}</code></p></section>
  `;
  if (kind === "parameter") {
    return common
      + `<section class="detail-section"><h3>玩家理解</h3><p>${escapeHTML(item.description)}</p></section>`
      + listSection("直接影响", item.effects.direct)
      + listSection("已知间接影响", item.effects.indirect)
      + listSection("不会自动改写", item.effects.excluded)
      + `<section class="detail-section"><h3>源码绑定</h3><p>${escapeHTML(bindingText(item.sourceBinding))}</p><p>预览消费者：${escapeHTML(item.previewBinding.consumer)} · ${escapeHTML(item.previewBinding.mode)}</p></section>`
      + `<section class="detail-section"><h3>原始记录</h3><pre class="detail-code">${escapeHTML(JSON.stringify(item, null, 2))}</pre></section>`;
  }
  if (kind === "asset") {
    return common
      + `<section class="detail-section"><h3>素材来源</h3><p>${escapeHTML(bindingText(item.source))}</p><p>槽位：${escapeHTML(item.slot)} · ${escapeHTML(item.technicalContract.kind)}</p></section>`
      + listSection("使用位置", item.usageSites.map(bindingText))
      + `<section class="detail-section"><h3>技术约束</h3><pre class="detail-code">${escapeHTML(JSON.stringify(item.technicalContract, null, 2))}</pre></section>`;
  }
  if (kind === "rule") {
    return common
      + `<section class="detail-section"><h3>当 / 如果 / 那么</h3><p>当：${escapeHTML(item.trigger)}</p><p>如果：${escapeHTML(item.condition)}</p><p>那么：${escapeHTML(item.result)}</p><p>反馈：${escapeHTML(item.playerFeedback)}</p></section>`
      + listSection("源码位置", item.sourceBindings.map(bindingText));
  }
  return common
    + `<section class="detail-section"><h3>世界设定</h3><p>${escapeHTML(item.body)}</p></section>`
    + listSection("源码位置", item.sourceBindings.map(bindingText))
    + listSection("关联素材", item.assetIds);
}

function defaultAssetCapability(asset) {
  return asset.technicalContract.kind === "model" || ["player", "enemy", "environment", "model", "animation"].includes(asset.category)
    ? "model.generate"
    : "image.generate";
}

function openWorldviewEditor(id) {
  const card = getWorldviewCard(id);
  if (!card) return;
  const draft = state.drafts[id]?.type === "edit-worldview" ? state.drafts[id] : null;
  const value = draft?.after ?? card;
  openDialog("WORLDVIEW DRAFT", `修改「${card.title}」`, `
    <section class="detail-section editor-boundary"><strong>只修改这一张世界观卡片</strong><p>保存后会生成 Codex 辅助 ChangeSet；不会自动修改玩法、数值或关联素材。</p></section>
    <div class="draft-editor">
      <label>标题<input type="text" data-worldview-title maxlength="120" value="${escapeHTML(value.title)}"></label>
      <label>设定正文<textarea data-worldview-body rows="7" maxlength="2400">${escapeHTML(value.body)}</textarea></label>
      <label>修改目的<input type="text" data-draft-reason maxlength="240" value="${escapeHTML(draft?.reason ?? "让世界设定更符合当前创作方向")}"></label>
    </div>
    <div class="dialog-actions">${draft ? `<button type="button" class="secondary-button" data-reset-content-draft="${escapeHTML(id)}">恢复原文</button>` : '<button type="button" class="secondary-button" data-dialog-cancel>取消</button>'}<button type="button" class="primary-button" data-save-worldview-draft="${escapeHTML(id)}">保存世界观草稿</button></div>
  `);
}

function openGameplayEditor(id) {
  const rule = getGameplayRule(id);
  if (!rule) return;
  const draft = state.drafts[id]?.type === "edit-gameplay" ? state.drafts[id] : null;
  const value = draft?.after ?? rule;
  openDialog("GAMEPLAY RULE DRAFT", `调整「${rule.label}」`, `
    <section class="detail-section editor-boundary"><strong>这是规则意图，不是直接改事件名</strong><p>Codex 会对照当前事件注册和消费者实施；本地精确写入器不会处理此草稿。</p></section>
    <div class="draft-editor draft-editor--grid">
      <label>当（触发）<textarea data-gameplay-trigger rows="2" maxlength="400">${escapeHTML(value.trigger)}</textarea></label>
      <label>如果（条件）<textarea data-gameplay-condition rows="2" maxlength="400">${escapeHTML(value.condition)}</textarea></label>
      <label>那么（结果）<textarea data-gameplay-result rows="3" maxlength="600">${escapeHTML(value.result)}</textarea></label>
      <label>玩家如何知道<textarea data-gameplay-feedback rows="3" maxlength="600">${escapeHTML(value.playerFeedback)}</textarea></label>
      <label class="editor-wide">修改目的<input type="text" data-draft-reason maxlength="240" value="${escapeHTML(draft?.reason ?? "调整这条规则的玩家体验")}"></label>
    </div>
    <div class="dialog-actions">${draft ? `<button type="button" class="secondary-button" data-reset-content-draft="${escapeHTML(id)}">恢复原规则</button>` : '<button type="button" class="secondary-button" data-dialog-cancel>取消</button>'}<button type="button" class="primary-button" data-save-gameplay-draft="${escapeHTML(id)}">保存玩法草稿</button></div>
  `);
}

function openAssetEditor(id) {
  const asset = getAsset(id);
  if (!asset || asset.category === "audio") return;
  const draft = state.drafts[id]?.type === "replace-asset" ? state.drafts[id] : null;
  const request = draft?.after?.generationRequest;
  const capability = request?.capability ?? defaultAssetCapability(asset);
  openDialog("ASSET CHANGESET DRAFT", `为「${asset.label}」准备候选素材`, `
    <section class="detail-section editor-boundary"><strong>先生成候选，再确认替换</strong><p>第三方服务尚未绑定。此处只生成标准请求和技术约束，不会上传项目文件或覆盖当前素材。</p></section>
    <div class="draft-editor">
      <label>生成类型<select data-asset-capability><option value="image.generate"${capability === "image.generate" ? " selected" : ""}>生成图片</option><option value="image.edit"${capability === "image.edit" ? " selected" : ""}>编辑图片</option><option value="model.generate"${capability === "model.generate" ? " selected" : ""}>生成 3D 模型</option></select></label>
      <label>服务适配器<input type="text" data-asset-provider value="${escapeHTML(request?.providerId ?? "provider.pending")}" pattern="[a-z][a-z0-9.-]*" maxlength="120"></label>
      <label>想要的素材<textarea data-asset-prompt rows="5" maxlength="2000" placeholder="描述风格、主体、色彩和用途">${escapeHTML(request?.prompt ?? "")}</textarea></label>
      <label>不希望出现<textarea data-asset-negative rows="3" maxlength="1000" placeholder="可选">${escapeHTML(request?.negativePrompt ?? "")}</textarea></label>
      <label>修改目的<input type="text" data-draft-reason maxlength="240" value="${escapeHTML(draft?.reason ?? "生成候选素材，确认后再替换当前槽位")}"></label>
    </div>
    <section class="detail-section"><h3>自动带入的技术约束</h3><pre class="detail-code">${escapeHTML(JSON.stringify(asset.technicalContract, null, 2))}</pre></section>
    <div class="dialog-actions">${draft ? `<button type="button" class="secondary-button" data-reset-content-draft="${escapeHTML(id)}">放弃素材方案</button>` : '<button type="button" class="secondary-button" data-dialog-cancel>取消</button>'}<button type="button" class="primary-button" data-save-asset-draft="${escapeHTML(id)}">保存素材草稿</button></div>
  `);
}

function saveWorldviewDraft(id) {
  const card = getWorldviewCard(id);
  setContentDraft(createWorldviewDraft(card, {
    title: dialog.querySelector("[data-worldview-title]").value,
    body: dialog.querySelector("[data-worldview-body]").value,
    reason: dialog.querySelector("[data-draft-reason]").value,
  }));
}

function saveGameplayDraft(id) {
  const rule = getGameplayRule(id);
  setContentDraft(createGameplayDraft(rule, {
    trigger: dialog.querySelector("[data-gameplay-trigger]").value,
    condition: dialog.querySelector("[data-gameplay-condition]").value,
    result: dialog.querySelector("[data-gameplay-result]").value,
    playerFeedback: dialog.querySelector("[data-gameplay-feedback]").value,
    reason: dialog.querySelector("[data-draft-reason]").value,
  }));
}

function saveAssetDraft(id) {
  const asset = getAsset(id);
  setContentDraft(createAssetDraft(asset, {
    capability: dialog.querySelector("[data-asset-capability]").value,
    providerId: dialog.querySelector("[data-asset-provider]").value,
    prompt: dialog.querySelector("[data-asset-prompt]").value,
    negativePrompt: dialog.querySelector("[data-asset-negative]").value,
    reason: dialog.querySelector("[data-draft-reason]").value,
  }));
}

function buildDraftChangeSet() {
  return createDraftChangeSet(state.model, state.drafts);
}

function buildAutomaticDraftChangeSet() {
  return createDraftChangeSet(state.model, Object.fromEntries(parameterDraftEntries().map((draft) => [draft.targetId, draft])));
}

function downloadDraftChangeSet() {
  if (draftCount() === 0) return;
  const contents = `${JSON.stringify(buildDraftChangeSet(), null, 2)}\n`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  link.download = `game-tuning-changeset-${state.model.modelId.replaceAll(".", "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function copyDraftChangeSet(button) {
  if (draftCount() === 0) return;
  await navigator.clipboard.writeText(JSON.stringify(buildDraftChangeSet(), null, 2));
  const original = button.textContent;
  button.textContent = "已复制，可交给 Codex";
  setTimeout(() => { button.textContent = original; }, 1600);
}

function openDialog(kicker, title, content) {
  dialogKicker.textContent = kicker;
  dialogTitle.textContent = title;
  dialogContent.innerHTML = content;
  dialog.showModal();
}

function openDraftSummary() {
  const entries = draftEntries();
  if (entries.length === 0) {
    openDialog("DRAFT CHANGESET PREVIEW", "当前没有草稿", `<section class="detail-section"><p>可从世界观、核心玩法、数值调优或素材库创建一项草稿。草稿只会保存在当前浏览器。</p></section>`);
    return;
  }
  const changeSet = buildDraftChangeSet();
  const operations = changeSet.operations.map((operation) => {
    const presentation = draftPresentation(state.drafts[operation.targetId]);
    return `<li><strong>${escapeHTML(presentation.label)}</strong><span>${escapeHTML(presentation.change)}</span><small>${escapeHTML(presentation.typeLabel)} · ${escapeHTML(bindingText(operation.sourceBinding))}</small></li>`;
  }).join("");
  openDialog("DRAFT CHANGESET PREVIEW", `${entries.length} 项待确认草稿`, `
    <section class="detail-section draft-dialog-status"><strong>尚未应用</strong><p>这份清单只记录准备修改什么。游戏文件仍然保持原样。</p></section>
    <section class="detail-section"><h3>独立操作</h3><ol class="changeset-operation-list">${operations}</ol></section>
    ${listSection("预期直接影响", changeSet.impact.expectedEffects)}
    ${listSection("明确保持不变", changeSet.impact.excludedEffects)}
    ${listSection("验证前警告", changeSet.impact.warnings)}
    <section class="detail-section"><h3>下一步</h3><p>数值操作可以进入本地二次确认；世界观、玩法和素材操作需要把完整 ChangeSet 交给 Codex 对照源码实施。两类操作不会混在一次自动写入中。</p></section>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-copy-changeset>复制给 Codex</button><button type="button" class="primary-button" data-download-changeset>下载 ChangeSet</button></div>
    <details class="changeset-json"><summary>查看机器可读 ChangeSet</summary><pre class="detail-code">${escapeHTML(JSON.stringify(changeSet, null, 2))}</pre></details>
  `);
}

function openDiscardDraftsDialog() {
  if (draftCount() === 0) return;
  openDialog("DISCARD LOCAL DRAFT", "放弃全部草稿？", `
    <section class="detail-section"><p>将清除当前浏览器中的 ${draftCount()} 项草稿。游戏源码没有被修改，因此不需要执行源码回滚。</p></section>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-cancel>继续保留</button><button type="button" class="danger-button" data-confirm-discard-all>确认放弃</button></div>
  `);
}

function proposedDraftChangeSet() {
  const changeSet = buildAutomaticDraftChangeSet();
  return { ...changeSet, state: "proposed" };
}

function applyOperationValues(operations, reverse = false) {
  for (const operation of operations) {
    const parameter = getParameter(operation.targetId);
    if (parameter) parameter.currentValue = reverse ? operation.before : operation.after;
  }
}

async function proposeChangeSet() {
  if (!isApplyMode() || !state.applyStatus.proposalEnabled || parameterDraftCount() === 0) return;
  const changeSet = proposedDraftChangeSet();
  const proposal = await requestJson("./api/changesets/propose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changeSet }),
  });
  state.activeProposal = { ...proposal, changeSet };
  const operationRows = changeSet.operations.map((operation) => {
    const parameter = getParameter(operation.targetId);
    return `<li><strong>${escapeHTML(parameter.label)}</strong><span>${formatNumber(operation.before)} → ${formatNumber(operation.after)}</span><small>${escapeHTML(bindingText(operation.sourceBinding))}</small></li>`;
  }).join("");
  openDialog("CONFIRM SOURCE APPLY", `确认写入 ${proposal.operationCount} 项参数？`, `
    <section class="detail-section apply-confirm-warning"><strong>${state.applyStatus.enabled ? "下一次确认将修改本地源码" : "安全确认预览：写入仍被锁定"}</strong><p>目标项目：${escapeHTML(proposal.projectName)}；涉及 ${proposal.fileCount} 个文件。${state.applyStatus.enabled ? "写入前服务会再次确认原值没有漂移，并保存备份。" : "当前服务没有源码写入授权，你可以检查全部操作，但不能执行应用。"}</p></section>
    <section class="detail-section"><h3>准备写入</h3><ol class="changeset-operation-list">${operationRows}</ol></section>
    ${listSection("明确保持不变", changeSet.impact.excludedEffects)}
    <label class="apply-confirm-check"><input type="checkbox" data-apply-confirm-check> <span>我确认只应用以上列出的参数，不扩展修改范围。</span></label>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-cancel>返回草稿</button><button type="button" class="danger-button" data-apply-proposal disabled>${state.applyStatus.enabled ? "确认写入源码" : "写入未授权"}</button></div>
  `);
}

async function applyActiveProposal(button) {
  const proposal = state.activeProposal;
  if (!proposal) return;
  button.disabled = true;
  if (state.preview.active) await stopRuntimePreview();
  button.textContent = "正在复核并写入…";
  const receipt = await requestJson("./api/changesets/apply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gtw-confirm": proposal.digest },
    body: JSON.stringify({ proposalId: proposal.proposalId, digest: proposal.digest, confirmed: true }),
  });
  applyOperationValues(receipt.changeSet.operations);
  const appliedTargets = new Set(receipt.changeSet.operations.map((operation) => operation.targetId));
  state.drafts = Object.fromEntries(Object.entries(state.drafts).filter(([targetId]) => !appliedTargets.has(targetId)));
  state.activeProposal = null;
  state.receipt = receipt;
  replaceReceipt(receipt);
  persistDrafts();
  updateDraftChrome();
  if (state.view === "tuning") renderViewContent();
  openApplyResult(receipt);
}

function verificationCopy(receipt) {
  const verification = receipt.verification;
  if (verification.status === "passed") return "项目构建通过；真实玩法仍需在浏览器中试玩确认。";
  if (verification.status === "failed") return "源码已写入，但项目构建失败。建议先撤销，再检查构建输出。";
  return "源码已写入；当前项目没有执行自动构建，仍需后续验证。";
}

function openApplyResult(receipt) {
  const failed = receipt.state === "failed";
  openDialog("APPLICATION RECEIPT", failed ? "写入完成，但构建失败" : "源码写入完成", `
    <section class="detail-section apply-result-status is-${escapeHTML(receipt.state)}"><strong>${failed ? "需要处理" : "已生成可撤销记录"}</strong><p>${escapeHTML(verificationCopy(receipt))}</p></section>
    <section class="detail-section"><h3>应用记录</h3><p><code>${escapeHTML(receipt.receiptId)}</code></p><p>${receipt.changeSet.operations.length} 项参数；${receipt.files.length} 个源码文件。</p></section>
    ${receipt.verification.command ? `<section class="detail-section"><h3>构建检查</h3><p>${escapeHTML(receipt.verification.command)} · ${escapeHTML(receipt.verification.status)}</p><pre class="detail-code">${escapeHTML((receipt.verification.output ?? "").slice(-4000))}</pre></section>` : ""}
    <section class="detail-section"><h3>仍需验证</h3><p>构建结果不能证明游戏手感正确。下一步需要真实试玩受影响行为，并确认排除项保持不变。</p></section>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-cancel>关闭</button><button type="button" class="danger-button" data-revert-receipt="${escapeHTML(receipt.receiptId)}">撤销本次应用</button></div>
  `);
}

function openRevertConfirmation(receiptId) {
  openDialog("RESTORE RECORDED VALUES", "确认撤销本次应用？", `
    <section class="detail-section"><p>工作台会逐项确认源码仍等于应用后的值，然后只把记录中的参数恢复到原值。不会重置仓库，也不会覆盖其他文件修改。</p></section>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-cancel>保留当前值</button><button type="button" class="danger-button" data-confirm-revert="${escapeHTML(receiptId)}">确认恢复原值</button></div>
  `);
}

async function revertReceipt(receiptId, button) {
  button.disabled = true;
  button.textContent = "正在检查并恢复…";
  const receipt = await requestJson("./api/changesets/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiptId }),
  });
  applyOperationValues(receipt.changeSet.operations, true);
  state.receipt = receipt;
  replaceReceipt(receipt);
  if (state.view === "tuning") renderViewContent();
  openDialog("ROLLBACK RECEIPT", "原值已经恢复", `
    <section class="detail-section apply-result-status is-reverted"><strong>撤销完成</strong><p>记录中的 ${receipt.changeSet.operations.length} 项参数已恢复，其他修改保持不变。</p></section>
    <section class="detail-section"><p><code>${escapeHTML(receipt.receiptId)}</code></p></section>
  `);
}

function showApplyError(error) {
  const drift = error.code === "SOURCE_DRIFT" || error.status === 409;
  openDialog("APPLICATION BLOCKED", drift ? "源码已变化，应用被阻止" : "无法完成这次应用", `
    <section class="detail-section apply-result-status is-failed"><strong>没有继续扩大修改</strong><p>${escapeHTML(error.message)}</p></section>
    <section class="detail-section"><h3>建议</h3><p>${drift ? "重新分析当前项目并生成新的草稿，避免覆盖用户或其他工具刚刚完成的修改。" : "保持现有草稿，检查本地应用服务与项目权限后重试。"}</p></section>
  `);
}

function openDetail(kind, id) {
  const item = findDetail(kind, id);
  if (!item) return;
  openDialog("SOURCE-BACKED DETAIL", item.label ?? item.title ?? item.id, renderDetail(kind, item));
}

document.querySelector("[data-dialog-close]").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  const saveWorldviewButton = event.target.closest("[data-save-worldview-draft]");
  const saveGameplayButton = event.target.closest("[data-save-gameplay-draft]");
  const saveAssetButton = event.target.closest("[data-save-asset-draft]");
  if (saveWorldviewButton || saveGameplayButton || saveAssetButton) {
    try {
      if (saveWorldviewButton) saveWorldviewDraft(saveWorldviewButton.dataset.saveWorldviewDraft);
      if (saveGameplayButton) saveGameplayDraft(saveGameplayButton.dataset.saveGameplayDraft);
      if (saveAssetButton) saveAssetDraft(saveAssetButton.dataset.saveAssetDraft);
      dialog.close();
      renderViewContent();
    } catch (error) {
      const existing = dialog.querySelector("[data-form-error]");
      if (existing) existing.remove();
      dialogContent.insertAdjacentHTML("afterbegin", `<section class="detail-section apply-result-status is-failed" data-form-error><strong>草稿还不能保存</strong><p>${escapeHTML(error.message)}</p></section>`);
    }
    return;
  }
  const resetContentButton = event.target.closest("[data-reset-content-draft]");
  if (resetContentButton) {
    clearDraft(resetContentButton.dataset.resetContentDraft);
    dialog.close();
    renderViewContent();
    return;
  }
  if (event.target.closest("[data-download-changeset]")) {
    downloadDraftChangeSet();
    return;
  }
  const copyChangeSetButton = event.target.closest("[data-copy-changeset]");
  if (copyChangeSetButton) {
    copyDraftChangeSet(copyChangeSetButton).catch((error) => {
      copyChangeSetButton.textContent = `复制失败：${error.message}`;
    });
    return;
  }
  if (event.target.closest("[data-dialog-cancel]")) {
    dialog.close();
    return;
  }
  if (event.target.closest("[data-confirm-discard-all]")) {
    state.drafts = {};
    persistDrafts();
    updateDraftChrome();
    dialog.close();
    if (state.view === "tuning") renderViewContent();
    return;
  }
  const applyButton = event.target.closest("[data-apply-proposal]");
  if (applyButton) {
    applyActiveProposal(applyButton).catch(showApplyError);
    return;
  }
  const revertButton = event.target.closest("[data-revert-receipt]");
  if (revertButton) {
    openRevertConfirmation(revertButton.dataset.revertReceipt);
    return;
  }
  const confirmRevert = event.target.closest("[data-confirm-revert]");
  if (confirmRevert) {
    revertReceipt(confirmRevert.dataset.confirmRevert, confirmRevert).catch(showApplyError);
    return;
  }
  const confirmDeleteEvidence = event.target.closest("[data-confirm-delete-evidence]");
  if (confirmDeleteEvidence) {
    deleteEvidence(confirmDeleteEvidence.dataset.receiptId, confirmDeleteEvidence.dataset.confirmDeleteEvidence, confirmDeleteEvidence).catch(showApplyError);
    return;
  }
  if (event.target === dialog) dialog.close();
});

dialog.addEventListener("change", (event) => {
  if (!event.target.matches("[data-apply-confirm-check]")) return;
  const button = dialog.querySelector("[data-apply-proposal]");
  if (button) button.disabled = !event.target.checked || !state.applyStatus.enabled;
});

window.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    app.querySelector("[data-search]:not(:disabled)")?.focus();
  }
});

async function requestJson(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `HTTP ${response.status}`), { code: payload.code, status: response.status });
  return payload;
}

async function loadApplyStatus() {
  if (!isApplyMode()) return;
  try {
    const status = await requestJson("./api/status");
    state.applyStatus = {
      loaded: true,
      proposalEnabled: status.proposalEnabled === true,
      enabled: status.applyEnabled === true,
      buildVerification: status.buildVerification === true,
      runtimePreviewEnabled: status.runtimePreviewEnabled === true,
      projectName: status.projectName,
    };
  } catch {
    state.applyStatus = { loaded: true, proposalEnabled: false, enabled: false, buildVerification: false, runtimePreviewEnabled: false };
  }
}

async function loadModel() {
  const [response, metadataResponse] = await Promise.all([
    fetch("./game-tuning-model.json", { cache: "no-store" }),
    fetch("./workbench-meta.json", { cache: "no-store" }).catch(() => null),
  ]);
  if (!response.ok) throw new Error(`模型加载失败：HTTP ${response.status}`);
  const model = await response.json();
  if (model?.project?.engine !== "three") throw new Error("该模型不是受支持的 Three.js 游戏模型");
  state.model = model;
  state.metadata = metadataResponse?.ok ? await metadataResponse.json() : { mode: "readonly" };
  state.mode = new Set(["draft", "apply"]).has(state.metadata.mode) ? state.metadata.mode : "readonly";
  await loadApplyStatus();
  await loadRuntimePreviewStatus();
  await refreshReceipts();
  loadDrafts();
  document.title = `${humanizeProjectName(model.project.name)} · 游戏调优工作台`;
  renderShell();
  updateDraftChrome();
  app.dataset.ready = "true";
  app.dataset.mode = state.mode;
  window.__GTW_READY__ = true;
}

loadModel().catch((error) => {
  app.className = "error-screen";
  app.innerHTML = `<div class="boot-mark" aria-hidden="true">ERR</div><h1>工作台无法打开</h1><p>${escapeHTML(error.message)}</p>`;
  app.dataset.ready = "false";
  window.__GTW_READY__ = false;
});
