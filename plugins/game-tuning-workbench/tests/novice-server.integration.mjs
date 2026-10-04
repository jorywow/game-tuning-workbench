import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture } from './novice-fixture.mjs';

const f = await fixture(); let child;
try {
  child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve-workbench.mjs', import.meta.url)), f.output, '--interactive', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', c => { logs += c; });
  const url = await new Promise((res, rej) => { const timer = setTimeout(() => rej(Error(logs || 'startup timeout')), 10000); child.stdout.on('data', c => { const m = String(c).match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(timer); res(m[0]); } }); child.on('exit', () => { clearTimeout(timer); rej(Error(logs)); }); });
  const get = path => fetch(`${url}api/flow/${path}`).then(r => r.json()); const status = await get('status');
  const post = (path, body, token = status.token, origin) => fetch(`${url}api/flow/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gtw-token': token, ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  assert.equal(status.permission, 'look');
  assert.equal((await post('permission', { choice: 'edit' }, 'bad')).ok, false);
  assert.equal((await post('permission', { choice: 'edit' }, status.token, 'http://evil.example')).ok, false);
  assert.equal((await post('permission', { choice: 'edit' })).ok, true);
  const drafts = { 'tuning.player-speed': { targetId: 'tuning.player-speed', type: 'set-parameter', before: 5, after: 8 } };
  assert.equal((await post('drafts', { drafts })).ok, true); assert.equal((await get('drafts')).drafts['tuning.player-speed'].after, 8);
  const job = await post('prepare', { drafts }).then(r => r.json()); let ready;
  for (let i = 0; i < 100; i++) { ready = await get(`job?id=${job.id}`); if (ready.state !== 'working') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(ready.state, 'ready'); assert.equal(await readFile(join(f.project, 'src/config.js'), 'utf8'), f.config);
  const r = await post('apply', { id: ready.proposal.id, digest: ready.proposal.digest, confirmed: true }).then(r => r.json());
  assert.equal(r.state, 'applied'); assert.equal(r.build.status, 'passed');
  assert.equal((await post('revert', { id: r.id })).ok, false);
  const reverted = await post('revert', { id: r.id, confirmed: true }).then(r => r.json()); assert.equal(reverted.state, 'reverted');
  assert.equal(await readFile(join(f.project, 'src/config.js'), 'utf8'), f.config);
  assert.equal((await fetch(`${url}.novice/receipt-${r.id}.json`)).status, 404);
  assert.equal((await fetch(`${url}api/changesets/apply`, { method: 'POST' })).status, 404);
  console.log('Novice HTTP integration passed: authorization, CSRF, draft persistence, prepare, confirm, build, receipts, guarded undo, private storage.');
} finally { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(f.root, { recursive: true, force: true }); }
