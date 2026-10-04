import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NoviceService } from '../scripts/novice-service.mjs';
import { createWorldviewDraft, createGameplayDraft, createAssetDraft } from '../assets/workbench/draft-model.js';
import { fixture } from './novice-fixture.mjs';

async function setup(t, options = {}) { const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const service = await new NoviceService({ model: f.model, workbenchRoot: f.output, canAuthorize: true, verifyBuild: false, ...options }).initialize(); return { ...f, service }; }
const speed = after => ({ 'tuning.player-speed': { targetId: 'tuning.player-speed', type: 'set-parameter', before: 5, after } });

test('novice flow locks source until choice and confirmation, persists drafts, applies and reverts', async t => {
  const f = await setup(t); const s = f.service;
  await assert.rejects(s.prepare(speed(8)), /允许修改/);
  await s.drafts(speed(8)); assert.equal((await s.drafts()).drafts['tuning.player-speed'].after, 8);
  s.authorize('edit'); const p = await s.prepare(speed(8));
  assert.equal(await readFile(join(f.project, 'src/config.js'), 'utf8'), f.config);
  await assert.rejects(s.apply({ id: p.id, digest: p.digest }), /确认/);
  const r = await s.apply({ id: p.id, digest: p.digest, confirmed: true });
  assert.match(await readFile(join(f.project, 'src/config.js'), 'utf8'), /walkSpeed: 8/);
  assert.equal(Object.keys((await s.drafts()).drafts).length, 0);
  await assert.rejects(s.apply({ id: p.id, digest: p.digest, confirmed: true }), /已经处理/);
  await assert.rejects(s.verify(r.id, r.checks.map(() => true)), /自动检查/);
  await s.revert(r.id); assert.equal(await readFile(join(f.project, 'src/config.js'), 'utf8'), f.config);
});
test('semantic proposal writes nothing before confirmation and preserves a reversible receipt', async t => {
  const f = await setup(t, { executor: async ({ files }) => ({ summary: '把星空改为海底', files: files.map(file => ({ path: file.path, after: file.source.replace('星空里的冒险', '海底的冒险') })) }) });
  f.service.authorize('edit'); const card = f.model.worldview.cards[0]; const draft = createWorldviewDraft(card, { title: '海底', body: '海底的冒险' });
  const p = await f.service.prepare({ [card.id]: draft }); const path = join(f.project, 'src/story.js');
  assert.match(await readFile(path, 'utf8'), /星空/);
  const r = await f.service.apply({ id: p.id, digest: p.digest, confirmed: true }); assert.match(await readFile(path, 'utf8'), /海底/);
  await writeFile(path, (await readFile(path, 'utf8')) + '// unrelated\n');
  await assert.rejects(f.service.revert(r.id), /其他修改/); assert.match(await readFile(path, 'utf8'), /unrelated/);
  await writeFile(path, r.patches[0].after); await f.service.revert(r.id); assert.match(await readFile(path, 'utf8'), /星空/);
});
test('rejects forged source targets, Codex scope expansion, bad drafts and invalid images', async t => {
  const f = await setup(t, { executor: async () => ({ summary: 'bad', files: [{ path: '../outside.js', after: 'bad' }] }) }); f.service.authorize('edit');
  assert.throws(() => f.service.canonicalDrafts({ unknown: { targetId: 'unknown', type: 'unsupported', before: {} } }));
  const rule = f.model.coreGameplay.rules[0];
  await assert.rejects(f.service.prepare({ [rule.id]: createGameplayDraft(rule, { ...rule, result: 'new rule' }) }), /文件范围/);
  await assert.rejects(f.service.candidates({ assetId: f.model.assets[0].id, dataUrl: 'data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcA==' }), /格式/);
  await symlink(join(f.project, 'src/config.js'), join(f.project, 'src/link.js'));
  await assert.rejects(f.service.boundFile('src/link.js'), /符号链接/);
});
test('source drift blocks apply, stale drafts survive for recovery, permission can be revoked', async t => {
  const f = await setup(t); f.service.authorize('edit'); await f.service.drafts(speed(8)); const p = await f.service.prepare(speed(8));
  await writeFile(join(f.project, 'src/config.js'), f.config.replace('5,', '6,'));
  await assert.rejects(f.service.apply({ id: p.id, digest: p.digest, confirmed: true }), /其他修改/);
  f.model.tuningParameters[0].currentValue = 6; assert.deepEqual((await f.service.drafts()).stale, ['tuning.player-speed']);
  f.service.authorize('look'); await assert.rejects(f.service.prepare(speed(8)), /允许修改/);
});
test('interrupted apply is recovered after restart without overwriting newer edits', async t => {
  const f = await setup(t); f.service.authorize('edit'); const p = await f.service.prepare(speed(8)); const r = await f.service.apply({ id: p.id, digest: p.digest, confirmed: true });
  r.state = 'applying'; await f.service.putReceipt(r);
  const restarted = await new NoviceService({ model: f.model, workbenchRoot: f.output, canAuthorize: true, verifyBuild: false }).initialize();
  assert.equal((await restarted.receipt(r.id)).state, 'recovery-needed'); restarted.authorize('edit'); await restarted.revert(r.id);
  assert.equal(await readFile(join(f.project, 'src/config.js'), 'utf8'), f.config);
});
test('concurrent jobs are rejected and worker failures leave source unchanged', async t => {
  let release; const barrier = new Promise(r => { release = r; });
  const f = await setup(t, { executor: async () => { await barrier; throw Error('worker offline'); } }); f.service.authorize('edit');
  const card = f.model.worldview.cards[0]; const drafts = { [card.id]: createWorldviewDraft(card, { title: 'new', body: 'new' }) };
  const first = await f.service.startJob(drafts); await assert.rejects(f.service.startJob(drafts), /上一份/); release();
  for (let i = 0; i < 100 && first.state === 'working'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(first.state, 'failed'); assert.match(await readFile(join(f.project, 'src/story.js'), 'utf8'), /星空/);
});

test('candidate images and asset requests retain the provider contract but cannot fake source replacement', async t => {
  const f = await setup(t); const asset = f.model.assets[0];
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const candidates = await f.service.candidates({ assetId: asset.id, label: '候选一', dataUrl: image });
  assert.equal(candidates.length, 1); assert.equal((await f.service.candidates())[0].label, '候选一');
  const draft = { ...createAssetDraft(asset, { prompt: '新的飞船', capability: 'model.generate' }), candidateId: candidates[0].id };
  await f.service.drafts({ [asset.id]: draft }); assert.equal((await f.service.drafts()).drafts[asset.id].candidateId, candidates[0].id);
  f.service.authorize('edit'); await assert.rejects(f.service.prepare({ [asset.id]: draft }), /素材服务尚未接入/);
});
test('stale draft backup is retained when the user saves a fresh draft', async t => {
  const f = await setup(t); await f.service.drafts(speed(8)); f.model.tuningParameters[0].currentValue = 6;
  await f.service.drafts({ 'tuning.player-speed': { targetId: 'tuning.player-speed', type: 'set-parameter', before: 6, after: 9 } });
  assert((await readdir(f.service.store)).some(name => name.startsWith('archived-drafts-')));
});
test('a prepared proposal is restored after reload, and verification refuses stale evidence', async t => {
  const f = await setup(t); f.service.authorize('edit'); await f.service.drafts(speed(8)); const p = await f.service.prepare(speed(8));
  assert.equal((await f.service.latestProposal()).id, p.id);
  const r = await f.service.apply({ id: p.id, digest: p.digest, confirmed: true });
  r.build = { status: 'passed' }; r.smoke = { status: 'passed' }; await f.service.putReceipt(r);
  await writeFile(join(f.project, 'src/config.js'), f.config.replace('5,', '9,'));
  await assert.rejects(f.service.verify(r.id, r.checks.map(() => true)), /又有变化/);
  await writeFile(join(f.project, 'src/config.js'), r.patches[0].after);
  assert.equal((await f.service.verify(r.id, r.checks.map(() => true))).state, 'verified');
});
