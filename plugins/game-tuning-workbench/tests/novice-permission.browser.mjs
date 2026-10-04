import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture } from './novice-fixture.mjs';

const playwright = process.env.GTW_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.GTW_PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const f = await fixture();
let server; let browser;
try {
  server = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve-workbench.mjs', import.meta.url)), f.output, '--interactive', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stderr.on('data', chunk => { logs += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs || 'Workbench startup timed out')), 10000);
    server.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.on('exit', () => { clearTimeout(timer); reject(Error(logs || 'Workbench exited')); });
  });
  try { browser = await playwright.chromium.launch({ headless: true }); }
  catch { browser = await playwright.chromium.launch({ headless: true, channel: 'chrome' }); }
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByRole('dialog').getByRole('button', { name: '允许修改' }).click();
  await page.locator('input[type="range"][data-param="tuning.player-speed"]').fill('8');
  await page.getByRole('button', { name: '查看修改清单' }).click();
  await page.getByRole('button', { name: '让 Codex 实施这份修改' }).waitFor();

  // A second page can revoke the shared session while this page still displays edit mode.
  const status = await fetch(`${url}api/flow/status`).then(response => response.json());
  const revoked = await fetch(`${url}api/flow/permission`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gtw-token': status.token }, body: JSON.stringify({ choice: 'look' }) });
  assert.equal(revoked.ok, true);
  await page.getByRole('button', { name: '让 Codex 实施这份修改' }).click();
  await page.getByRole('status').first().getByText('这个工作台会话已切回“先看看”。请重新选择“允许修改”，然后再试。').waitFor();
  await page.getByRole('button', { name: '让 Codex 实施这份修改' }).isDisabled().then(value => assert.equal(value, true));
  await page.locator('.n-next').getByRole('button', { name: '允许修改' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '允许修改' }).click();
  await page.getByRole('heading', { name: '试着改一点' }).waitFor();
  await page.getByRole('button', { name: '查看修改清单' }).click();
  await page.getByRole('button', { name: '让 Codex 实施这份修改' }).click();
  await page.getByText('修改方案已准备好。建议先试玩，再确认保存。').waitFor();
  console.log('Novice browser permission flow passed: stale edit state is synchronized and reauthorization can prepare a proposal.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  await rm(f.root, { recursive: true, force: true });
}
