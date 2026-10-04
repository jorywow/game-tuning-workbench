import { createWorldviewDraft, createGameplayDraft, createAssetDraft, normalizeDraftValue } from './draft-model.js';
import { plainLanguage, parameterGroups } from './novice-copy.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#detail-dialog');
const state = { model: null, permission: 'look', stage: 'explore', tab: 'tuning', group: 'controls', drafts: {}, candidates: [], receipts: [], proposal: null, preview: null, variant: 'baseline', busy: false, notice: '', saved: '', token: '', stale: [] };
let saving = Promise.resolve();
const e = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const count = () => Object.keys(state.drafts).length;
const titles = { explore: '认识你的游戏', change: '试着改一点', confirm: '看看改了什么', history: '检查与恢复' };
const tabs = { tuning: '手感与难度', worldview: '故事与世界', gameplay: '怎么玩', assets: '画面与素材' };
const api = async (action, body) => {
  const response = await fetch(`/api/flow/${action}`, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-gtw-token': state.token }, body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || '没有完成操作，请重试。'), { code: value.code }); return value;
};
async function syncPermission() {
  const status = await api('status');
  if (state.token && state.token !== status.token) {
    state.permission = 'look'; state.proposal = null;
    throw new Error('工作台服务已重新启动，请刷新页面后重新选择权限。');
  }
  const changed = state.permission !== status.permission;
  state.permission = status.permission; state.token = status.token;
  return changed;
}
async function requireCurrentEdit() {
  if (await syncPermission() && state.permission !== 'edit') {
    state.proposal = null;
    throw new Error('这个工作台会话已切回“先看看”。请重新选择“允许修改”，然后再试。');
  }
  if (state.permission !== 'edit') throw new Error('请先选择“允许修改”。每次保存仍会请你确认。');
}
const button = (label, action, attrs = '', primary = false) => `<button type="button" class="n-button${primary ? ' primary' : ''}" data-action="${action}" ${attrs}>${label}</button>`;
const details = (value, label = '高级详情') => `<details class="n-details"><summary>${label}</summary><pre>${e(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre></details>`;
const tag = confidence => `<span class="n-tag">${confidence === 'confirmed' ? '有项目依据' : '根据项目推测，待你确认'}</span>`;
const empty = text => `<div class="n-empty">${e(text)}</div>`;
const assetById = id => state.model.assets.find(x => x.id === id);
const safeImage = value => typeof value === 'string' && /^(media|candidates|evidence)\/[a-zA-Z0-9._-]+$/.test(value) ? value : null;
const photo = (url, label) => safeImage(url) ? `<img class="n-photo" src="${e(url)}" alt="${e(label)}" loading="lazy">` : `<div class="n-placeholder">${e(label || '暂无图片')}<small>没有图片时，我们不会假装已预览</small></div>`;
function target(id) { return [...state.model.tuningParameters, ...state.model.worldview.cards, ...state.model.coreGameplay.rules, ...state.model.assets].find(x => x.id === id); }
function label(id) { const item = target(id); return item?.label || item?.title || '游戏内容'; }
function persist() {
  state.proposal = null; state.saved = '正在保存草稿…';
  const snapshot = structuredClone(state.drafts);
  const operation = saving.catch(() => {}).then(() => api('drafts', { drafts: snapshot }));
  saving = operation;
  operation.then(() => { if (saving === operation) { state.saved = '草稿已保存在这台电脑'; updateStatus(); } }).catch(error => { state.notice = `草稿保存失败：${error.message}。请保持页面打开后重试。`; state.saved = '尚未保存'; updateStatus(); });
}
function updateStatus() { const node = app.querySelector('[data-status]'); if (node) node.textContent = state.notice || state.saved; }
function render() {
  app.className = 'novice-app';
  app.innerHTML = `<header class="n-header"><a href="#" data-action="home" class="n-brand">◈ 游戏调优工作台</a><div><span class="n-project">${e(state.model.project.name)}</span><span class="n-tag">${state.permission === 'edit' ? '允许修改 · 每次保存前仍需确认' : '先看看 · 游戏不会被修改'}</span>${button(state.permission === 'edit' ? '切回先看看' : '允许修改', 'permission')}</div></header>
    <nav class="n-progress" aria-label="调整游戏的步骤">${Object.entries(titles).map(([key, title], index) => `<button data-action="stage" data-stage="${key}" aria-current="${state.stage === key ? 'step' : 'false'}"><span>${index + 1}</span>${title}</button>`).join('<i aria-hidden="true">→</i>')}</nav>
    <main class="n-main"><div class="n-heading"><div><small>你的游戏，由你决定</small><h1>${titles[state.stage]}</h1><p>${state.stage === 'explore' ? '先了解，再动手。任何调整都先留在草稿里。' : state.stage === 'change' ? '改一个地方，试一下感觉。不会因为拖动滑杆就保存进游戏。' : state.stage === 'confirm' ? '这里列出本次修改。只有你确认后，才会保存进游戏。' : '每次保存都有记录。发现不满意，可以恢复到修改之前。'}</p></div>${button('试玩当前游戏', 'play-original', state.busy ? 'disabled' : '')}</div>
    <p class="n-status" role="status" data-status>${e(state.notice || state.saved)}</p>
    ${state.stale.length ? `<aside class="n-warning">游戏已发生变化，${state.stale.length} 项旧草稿暂未载入，原始草稿仍保留在本地。请核对最新内容后重新调整。</aside>` : ''}
    ${state.stage === 'history' ? history() : state.stage === 'confirm' ? confirmation() : exploration()}
    ${state.preview ? preview() : ''}
    ${state.busy ? '<div class="n-working" role="status"><span class="n-spinner"></span>正在处理，请稍候。你的草稿仍然保留。</div>' : ''}
    </main><footer class="n-footer"><span>${count() ? `有 ${count()} 项未保存进游戏的修改` : '还没有待保存的修改'}</span><div>${count() ? button('查看修改清单', 'stage', 'data-stage="confirm"') : ''}${button(state.permission === 'edit' ? '试着改一点' : '允许修改', state.permission === 'edit' ? 'stage' : 'permission', 'data-stage="change"', true)}</div></footer>`;
  app.dataset.ready = 'true'; window.__GTW_READY__ = true;
}
function exploration() {
  return `<div class="n-tabs" role="tablist" aria-label="游戏内容">${Object.entries(tabs).map(([id, text]) => `<button role="tab" aria-selected="${state.tab === id}" data-action="tab" data-tab="${id}">${text}</button>`).join('')}</div>
    ${state.permission === 'look' ? '<p class="n-muted">现在可以浏览和试玩。想调整内容时，选择右上角的“允许修改”。</p>' : ''}
    ${state.tab === 'tuning' ? tuning() : state.tab === 'worldview' ? worldview() : state.tab === 'gameplay' ? gameplay() : assets()}
    ${details({ project: state.model.project, modelId: state.model.modelId }, '高级详情：项目与分析范围')}`;
}
function tuning() {
  const groups = [...new Set(state.model.tuningParameters.map(p => p.group))];
  if (!groups.includes(state.group) && state.group !== 'all') state.group = groups[0];
  const filtered = state.model.tuningParameters.filter(p => state.group === 'all' || p.group === state.group);
  return `<div class="n-actions" aria-label="调整哪种体验">${groups.map(group => button(parameterGroups[group] || '其他设置', 'group', `data-group="${e(group)}"`, state.group === group)).join('')}${groups.length > 1 ? button('所有设置', 'group', 'data-group="all"', state.group === 'all') : ''}</div><div class="n-grid">${filtered.map(p => {
    const after = state.drafts[p.id]?.after ?? p.currentValue;
    return `<article class="n-card"><div class="n-card-top"><h2>${e(plainLanguage(p.label))}</h2>${state.drafts[p.id] ? '<span class="n-tag accent">未保存进游戏</span>' : ''}</div><p>${e(plainLanguage(p.description))}</p><div class="n-number"><strong data-value-for="${e(p.id)}">${e(after)}</strong><span>${e(plainLanguage(p.unit || ''))} · 当前游戏 ${e(p.currentValue)}</span></div><label class="n-range"><span class="sr-only">${e(plainLanguage(p.label))}</span><input type="range" data-param="${e(p.id)}" min="${p.safeRange.min}" max="${p.safeRange.max}" step="${p.safeRange.step}" value="${after}" ${state.permission !== 'edit' ? 'disabled' : ''}></label><div class="n-range-labels"><span>${e(plainLanguage(p.playerMeaning?.lower))}</span><span>${e(plainLanguage(p.playerMeaning?.higher))}</span></div><label class="n-exact">直接填数值 <input type="number" aria-label="${e(plainLanguage(p.label))}的数值" data-param="${e(p.id)}" min="${p.safeRange.min}" max="${p.safeRange.max}" step="${p.safeRange.step}" value="${after}" ${state.permission !== 'edit' ? 'disabled' : ''}></label><p class="n-muted">只调整：${e(plainLanguage(p.effects.direct.join('；')))}</p>${state.drafts[p.id] ? button('恢复这一项', 'reset', `data-id="${e(p.id)}"`) : ''}${details({ recommendedRange: p.safeRange, effects: p.effects, source: p.sourceBinding, originalDescription: p.description })}</article>`;
  }).join('') || empty(state.model.project.limitations.find(text => text.includes('调优契约') || text.includes('调优字段')) || '还没有找到能安全调整的数值。可以让 Codex 为这个游戏接入调优参数；不能只显示不生效的滑杆。')}</div>`;
}
function worldview() {
  return `<div class="n-grid">${state.model.worldview.cards.map(card => {
    const value = state.drafts[card.id]?.after ?? card; const refs = state.candidates.filter(x => x.assetId === card.id); const related = (card.assetIds || []).map(assetById).find(x => safeImage(x?.preview));
    return `<article class="n-card n-world">${photo(refs.at(-1)?.url || related?.preview, '世界观参考图')}<div class="n-pad">${tag(card.confidence)}<h2>${e(value.title)}</h2><p class="n-prose">${e(value.body)}</p><p class="n-muted">参考图片只保存在工作台，不会自动换掉游戏画面。</p><div class="n-actions">${button('修改这段设定', 'edit-world', `data-id="${e(card.id)}" ${state.permission !== 'edit' ? 'disabled' : ''}`)}${upload(card.id, '添加参考图')}</div>${details(card, '高级详情：这段设定来自哪里')}</div></article>`;
  }).join('') || empty('暂时没有足够依据描述世界观。请先让 Codex 补充游戏设定或关联图片。')}</div>`;
}
function gameplay() {
  return `<section class="n-card"><h2>${e(state.model.coreGameplay.summary || '玩家会经历什么')}</h2><ol class="n-loop">${state.model.coreGameplay.loopSteps.map(step => `<li><strong>${e(step.playerAction)}</strong><span>游戏回应：${e(step.gameResponse)}</span><span class="n-good">得到：${e(step.reward)}</span><span>挑战：${e(step.risk)}</span>${tag(step.confidence)}</li>`).join('')}</ol></section><h2 class="n-section-title">逐条调整游戏规则</h2><div class="n-grid">${state.model.coreGameplay.rules.map(rule => {
    const value = state.drafts[rule.id]?.after ?? rule;
    return `<article class="n-card"><h2>${e(plainLanguage(rule.label))}</h2><div class="n-rule-flow"><div><small>什么时候</small>${e(plainLanguage(value.trigger))}</div><b aria-hidden="true">↓</b><div><small>满足什么条件</small>${e(plainLanguage(value.condition))}</div><b aria-hidden="true">↓</b><div><small>发生什么</small>${e(plainLanguage(value.result))}</div><div class="n-feedback"><small>玩家感受到</small>${e(plainLanguage(value.playerFeedback))}</div></div>${button('修改这条规则', 'edit-rule', `data-id="${e(rule.id)}" ${state.permission !== 'edit' ? 'disabled' : ''}`)}${details(rule)}</article>`;
  }).join('') || empty('暂未识别到可追溯的玩法规则。')}</div>`;
}
function upload(id, text) { return `<label class="n-button n-upload">${text}<input type="file" data-upload="${e(id)}" accept="image/png,image/jpeg,image/webp" aria-label="${text}" ${state.busy ? 'disabled' : ''}></label>`; }
function assets() {
  return `<aside class="n-note">可以上传已有图片进行并排比较。生图和生模型服务尚未连接，不会产生生成费用；程序生成的模型需要单独接入，图片候选不等于已替换的 3D 模型。</aside><div class="n-asset-list">${state.model.assets.map(asset => {
    const candidates = state.candidates.filter(x => x.assetId === asset.id); const selected = state.drafts[asset.id]?.candidateId;
    return `<article class="n-card"><div class="n-card-top"><h2>${e(asset.label)}</h2>${upload(asset.id, '添加候选图片')}</div><div class="n-candidates"><div><span class="n-tag">当前素材</span>${photo(asset.preview, asset.technicalContract?.kind === 'generated-runtime' ? '由游戏程序绘制' : '暂无可用预览')}</div>${candidates.map(c => `<div class="${selected === c.id ? 'n-selected' : ''}"><span class="n-tag">${e(c.label)}</span>${photo(c.url, c.label)}${button(selected === c.id ? '已选为参考' : '选择这个方向', 'select-candidate', `data-id="${e(asset.id)}" data-candidate="${c.id}" ${state.permission !== 'edit' ? 'disabled' : ''}`)}</div>`).join('')}</div>${button('描述想怎么改', 'edit-asset', `data-id="${e(asset.id)}" ${state.permission !== 'edit' ? 'disabled' : ''}`)}${state.drafts[asset.id] ? `<p>修改想法：${e(state.drafts[asset.id].after.generationRequest.prompt)}</p><p class="n-muted">已记录需求。尚未接入素材替换，不能保存进游戏。</p>${button('移除这项需求', 'reset', `data-id="${e(asset.id)}"`)}` : ''}${details(asset)}</article>`;
  }).join('') || empty('暂时没有找到素材。')}</div>`;
}
function confirmation() {
  if (!count()) return empty('还没有修改。先到“试着改一点”里调整一个你关心的内容。');
  const hasAsset = Object.values(state.drafts).some(d => d.type === 'replace-asset');
  const proposal = state.proposal;
  return `<div class="n-confirm-layout"><section class="n-card"><h2>这次只改这 ${count()} 项</h2>${Object.entries(state.drafts).map(([id, d]) => `<div class="n-change-row"><div><h3>${e(label(id))}</h3>${typeof d.after === 'number' ? `<p>${e(d.before)} → <strong>${e(d.after)}</strong></p>` : `<p>${e(d.after.title || d.after.result || d.after.generationRequest?.prompt)}</p>`}</div>${button('不改这项', 'reset', `data-id="${e(id)}"`)}</div>`).join('')}
      ${proposal ? `<h3>准备完成</h3><p>${e(proposal.summary)}</p><p>将保存 ${proposal.patches.length} 个文件；如果这些文件已有其他修改，工作台会停下来，不会强行覆盖。</p><ul>${proposal.changeSet.impact.expectedEffects.map(t => `<li>${e(t)}</li>`).join('')}</ul><h3>还要确认这些没有被意外影响</h3><ul>${proposal.changeSet.impact.excludedEffects.map(t => `<li>${e(t)}</li>`).join('')}</ul>${details(proposal.patches.map(f => `${f.path}\n--- 修改前 ---\n${f.before}\n--- 修改后 ---\n${f.after}`).join('\n\n'), '高级详情：完整文件对照')}` : '<p class="n-muted">玩法和故事修改需要 Codex 理解后准备方案。下一步不会直接改你的游戏。</p>'}</section>
    <aside class="n-card n-next"><h2>先试，再保存</h2>${hasAsset ? '<p class="n-warning">素材需求已经记录，但替换服务尚未接入。请先移除素材需求，再保存其他修改。</p>' : ''}
    ${button('试试修改后的游戏', 'play-draft', `${state.busy || hasAsset ? 'disabled' : ''}`, false)}
    ${button(proposal ? '重新准备修改方案' : '让 Codex 实施这份修改', 'prepare', `${state.busy || hasAsset || state.permission !== 'edit' ? 'disabled' : ''}`, true)}<p class="n-muted">Codex 只准备待确认方案。复杂修改会使用你的 Codex 账号额度；准备好后仍需你确认保存。</p>
    ${proposal ? `<label class="n-consent"><input type="checkbox" data-confirm>我确认只保存上面列出的修改</label>${button('确认保存进游戏', 'apply', 'disabled', true)}` : ''}
    ${state.permission !== 'edit' ? button('允许修改', 'permission') : ''}</aside></div>`;
}
function preview() {
  const url = state.preview.session?.[state.variant === 'baseline' ? 'baselineUrl' : 'draftUrl'];
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url || '')) return '';
  return `<section class="n-card n-preview"><div class="n-card-top"><div><h2>试玩对比</h2><p>这是临时副本，不会因为试玩而保存修改。切换版本会重新开始。</p></div>${button('收起试玩', 'close-preview')}</div><div class="n-tabs">${button('原来的游戏', 'variant', 'data-variant="baseline"', state.variant === 'baseline')}${button('这次准备的版本', 'variant', 'data-variant="draft"', state.variant === 'draft')}</div><p class="n-muted">${state.preview.session.operationCount ? `本次预览包含 ${state.preview.session.operationCount} 项修改。继续调整后请重新点击“试试修改后的游戏”。` : '当前两个窗口都是原版，还没有加入修改。'}</p><iframe title="游戏试玩" src="${url}" allow="fullscreen; gamepad" sandbox="allow-scripts allow-same-origin allow-pointer-lock" allowfullscreen></iframe></section>`;
}
function history() {
  return `<div class="n-history">${state.receipts.map(r => `<article class="n-card"><div class="n-card-top"><h2>${e(r.summary)}</h2><span class="n-tag">${({ applied: '已保存，等你试玩', verified: '检查完成', reverted: '已恢复', failed: '保存未完成', 'recovery-needed': '上次被中断，需要恢复', applying: '保存中' })[r.state] || '处理中'}</span></div><p class="n-muted">${new Date(r.createdAt).toLocaleString('zh-CN')}</p><p>${e(r.build?.message || r.error || '')}</p><p>${e(r.smoke?.message || '还没有自动试玩证据。')}</p>${r.smoke?.screenshot ? photo(r.smoke.screenshot, '自动试玩截图') : ''}
    ${['applied', 'verified'].includes(r.state) ? `<div class="n-actions">${button('重新自动检查并截图', 'smoke', `data-id="${r.id}" ${state.busy ? 'disabled' : ''}`)}${button('试玩保存后的游戏', 'play-original')}</div><h3>还需要你亲自确认</h3><div class="n-checks">${r.checks.map((c, index) => `<label><input type="checkbox" data-check="${r.id}" data-index="${index}" ${c.passed ? 'checked' : ''} ${r.state === 'verified' ? 'disabled' : ''}>${e(c.label)}</label>`).join('')}</div>${r.state === 'applied' ? button('我已试玩，以上都正常', 'verify', `data-id="${r.id}"`) : ''}` : ''}
    ${['applied', 'verified', 'recovery-needed'].includes(r.state) ? button('撤销这次修改', 'revert-dialog', `data-id="${r.id}"`) : ''}${details(r, '高级详情：文件变化与检查记录')}</article>`).join('') || empty('还没有保存记录。修改草稿不会出现在这里。')}</div>`;
}
function showDialog(title, content) {
  document.querySelector('[data-dialog-kicker]').textContent = '按你的想法调整'; document.querySelector('#detail-title').textContent = title;
  document.querySelector('#detail-content').innerHTML = content; if (!dialog.open) dialog.showModal();
}
function wizard() {
  showDialog('欢迎，先选一种开始方式', `<p>这是你的游戏调优工作台。草稿与游戏分开保存，每次真正修改游戏前都会请你确认。</p><div class="n-wizard">${button('先看看', 'choose', 'data-choice="look"', true)}<p>浏览故事、玩法、素材，试玩当前游戏。</p>${button('允许修改', 'choose', 'data-choice="edit"')}<p>可以调整草稿，确认后保存进当前游戏。刷新页面不会额外开放其他项目权限。</p></div>`);
}
function editor(kind, id) {
  const item = target(id); const value = state.drafts[id]?.after ?? item;
  const fields = kind === 'world' ? { title: '世界设定的标题', body: '这是什么世界？玩家在这里经历什么？' } : kind === 'rule' ? { trigger: '什么时候发生？', condition: '需要满足什么条件？', result: '游戏应该怎么回应？', playerFeedback: '玩家会看到或听到什么？' } : { prompt: '想把这个素材改成什么样？' };
  showDialog(label(id), `<form data-editor="${kind}" data-id="${e(id)}">${Object.entries(fields).map(([key, text]) => `<label class="n-field">${text}<textarea name="${key}" required maxlength="12000" rows="${key === 'body' || key === 'prompt' ? 5 : 2}">${e(key === 'prompt' ? value.generationRequest?.prompt || '' : value[key])}</textarea></label>`).join('')}<p class="n-muted">保存的是修改想法，不会立刻改变游戏。</p><button type="submit" class="n-button primary">保存到草稿</button><p data-form-error role="alert"></p></form>`);
}
async function refresh() { state.model = await fetch('./game-tuning-model.json', { cache: 'no-store' }).then(r => r.json()); state.receipts = await api('receipts'); }
async function previewGame(draft) {
  if (draft && !state.proposal && Object.values(state.drafts).some(d => d.type !== 'set-parameter')) throw new Error('故事和玩法修改需要先点击“让 Codex 实施这份修改”，准备完成后才能试玩。');
  state.preview = await api('preview', draft ? state.proposal ? { proposalId: state.proposal.id } : { drafts: state.drafts } : {}); state.variant = draft ? 'draft' : 'baseline';
}
async function prepare() {
  await requireCurrentEdit();
  await saving; const job = await api('prepare', { drafts: state.drafts });
  state.notice = '正在准备修改方案，游戏还没有改变。你可以稍等片刻。'; updateStatus();
  for (;;) {
    const result = await api(`job?id=${job.id}`);
    if (result.state === 'failed') throw new Error(result.message);
    if (result.state === 'ready') { state.proposal = result.proposal; state.notice = '修改方案已准备好。建议先试玩，再确认保存。'; return; }
    await new Promise(done => setTimeout(done, 1200));
  }
}
async function action(node) {
  const a = node.dataset.action; const id = node.dataset.id;
  if (a === 'permission') { if (state.permission === 'look') wizard(); else { Object.assign(state, await api('permission', { choice: 'look' })); state.proposal = null; } }
  else if (a === 'choose') { Object.assign(state, await api('permission', { choice: node.dataset.choice })); sessionStorage.setItem(`gtw-onboard:${state.model.modelId}`, 'done'); dialog.close(); state.stage = state.permission === 'edit' ? 'change' : 'explore'; }
  else if (a === 'stage') { state.stage = node.dataset.stage; if (state.stage === 'history') await refresh(); }
  else if (a === 'home') state.stage = 'explore';
  else if (a === 'tab') state.tab = node.dataset.tab;
  else if (a === 'group') state.group = node.dataset.group;
  else if (a === 'edit-world') editor('world', id);
  else if (a === 'edit-rule') editor('rule', id);
  else if (a === 'edit-asset') editor('asset', id);
  else if (a === 'reset') { delete state.drafts[id]; persist(); }
  else if (a === 'play-original') await previewGame(false);
  else if (a === 'play-draft') await previewGame(true);
  else if (a === 'variant') state.variant = node.dataset.variant;
  else if (a === 'close-preview') state.preview = null;
  else if (a === 'prepare') await prepare();
  else if (a === 'apply') {
    if (!app.querySelector('[data-confirm]')?.checked || !state.proposal) return;
    await requireCurrentEdit();
    const r = await api('apply', { id: state.proposal.id, digest: state.proposal.digest, confirmed: true });
    state.proposal = null; state.preview = null; state.stage = 'history';
    state.drafts = (await api('drafts')).drafts; await refresh(); render();
    state.notice = '已经保存，正在自动打开游戏并记录截图。'; updateStatus();
    await api('smoke', { id: r.id }); await refresh();
    state.notice = '保存和自动检查结束。请查看记录，并亲自确认手感与玩法。';
  }
  else if (a === 'smoke') { await api('smoke', { id }); await refresh(); }
  else if (a === 'verify') { const checks = [...app.querySelectorAll(`[data-check="${id}"]`)].map(n => n.checked); await api('verify', { id, checks }); await refresh(); }
  else if (a === 'revert-dialog') showDialog('恢复到这次修改之前？', `<p>只恢复这条记录包含的文件。如果文件后来又被修改，会停止操作，避免覆盖你的新内容。</p>${button('确认撤销这次修改', 'revert', `data-id="${id}"`, true)}${button('保留修改', 'close-dialog')}`);
  else if (a === 'close-dialog') dialog.close();
  else if (a === 'revert') { await requireCurrentEdit(); await api('revert', { id, confirmed: true }); dialog.close(); state.preview = null; state.proposal = null; await refresh(); state.notice = '已恢复。请重新试玩，确认游戏状态。'; }
  else if (a === 'select-candidate') {
    const asset = assetById(id); const c = state.candidates.find(x => x.id === node.dataset.candidate);
    const kind = asset.technicalContract?.kind; const capability = kind === 'model' || kind === 'generated-runtime' ? 'model.generate' : 'image.generate';
    state.drafts[id] = { ...createAssetDraft(asset, { prompt: `参考图片「${c.label}」的视觉方向调整，保留现有玩法。`, capability }), candidateId: c.id }; persist();
  }
}
const slow = new Set(['prepare', 'apply', 'smoke', 'play-original', 'play-draft', 'revert', 'verify']);
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-dialog-close]'); if (close) { dialog.close(); return; }
  const node = event.target.closest('[data-action]'); if (!node || node.disabled) return; event.preventDefault();
  if (state.busy) return;
  const isSlow = slow.has(node.dataset.action); state.notice = '';
  try {
    // Read checkbox state before replacing the UI.
    if (isSlow) { state.busy = true; node.disabled = true; state.notice = node.dataset.action === 'prepare' ? 'Codex 正在准备方案，请稍候…' : '正在处理，请稍候…'; updateStatus(); }
    await action(node);
    if (state.notice === '正在处理，请稍候…') state.notice = '操作完成。';
  } catch (error) {
    if (error.code === 'PERMISSION_REQUIRED' && ['prepare', 'apply', 'revert'].includes(node.dataset.action)) {
      await syncPermission().catch(() => {});
      state.proposal = null;
      state.notice = '这个工作台会话已切回“先看看”。请重新选择“允许修改”，然后再试。';
    } else state.notice = error.message;
    if (dialog.open && node.dataset.action === 'revert') dialog.close();
  }
  finally { state.busy = false; render(); }
});
document.addEventListener('input', event => {
  if (event.target.matches('[data-confirm]')) app.querySelector('[data-action="apply"]').disabled = !event.target.checked || state.permission !== 'edit';
  const id = event.target.dataset.param; if (id) { const display = [...app.querySelectorAll('[data-value-for]')].find(n => n.dataset.valueFor === id); if (display) display.textContent = event.target.value; }
});
document.addEventListener('change', async event => {
  const id = event.target.dataset.param;
  if (id && state.permission === 'edit' && !state.busy) {
    if (event.target.value.trim() === '') { state.notice = '请输入一个数值，空白不会保存。'; render(); return; }
    const p = target(id); const after = normalizeDraftValue(p, event.target.value);
    state.notice = after !== Number(event.target.value) ? '已将数值调整到建议范围与步长内，请确认是否符合你的想法。' : '';
    if (after === p.currentValue) delete state.drafts[id]; else state.drafts[id] = { targetId: id, type: 'set-parameter', before: p.currentValue, after, applicationStrategy: 'automatic' };
    persist(); render();
  }
  const assetId = event.target.dataset.upload;
  if (assetId && !state.busy) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('请选择小于 8 MB 的图片。');
      const dataUrl = await new Promise((res, rej) => { const reader = new FileReader(); reader.onload = () => res(reader.result); reader.onerror = rej; reader.readAsDataURL(file); });
      state.candidates = await api('candidates', { assetId, label: file.name, dataUrl }); state.notice = '图片已加入工作台，仅供参考和比较；游戏没有改变。';
    } catch (error) { state.notice = error.message; } render();
  }
});
document.addEventListener('submit', event => {
  const form = event.target.closest('[data-editor]'); if (!form) return; event.preventDefault();
  if (state.permission !== 'edit' || state.busy) return;
  try {
    const item = target(form.dataset.id); const value = Object.fromEntries(new FormData(form));
    const draft = form.dataset.editor === 'world' ? createWorldviewDraft(item, value) : form.dataset.editor === 'rule' ? createGameplayDraft(item, value) : createAssetDraft(item, { ...value, capability: ['model', 'generated-runtime'].includes(item.technicalContract?.kind) ? 'model.generate' : 'image.generate' });
    if (JSON.stringify(draft.before) === JSON.stringify(draft.after)) delete state.drafts[item.id]; else state.drafts[item.id] = draft;
    persist(); dialog.close(); render();
  } catch (error) { form.querySelector('[data-form-error]').textContent = error.message; }
});

try {
  Object.assign(state, await api('status')); await refresh();
  const saved = await api('drafts'); state.drafts = saved.drafts; state.stale = saved.stale;
  state.candidates = await api('candidates'); state.saved = count() ? '已恢复这台电脑上保存的草稿' : '';
  state.proposal = await api('proposal');
  render(); if (!sessionStorage.getItem(`gtw-onboard:${state.model.modelId}`)) wizard();
} catch (error) { app.innerHTML = `<div class="n-empty"><h1>暂时没有打开工作台</h1><p>${e(error.message)}</p><p>回到 Codex，说“重新打开这个游戏的调优工作台”。</p></div>`; }
window.addEventListener('focus', async () => {
  if (state.busy) return;
  try { if (await syncPermission()) { state.proposal = null; render(); } }
  catch (error) { state.notice = error.message; render(); }
});
