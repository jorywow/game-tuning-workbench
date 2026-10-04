#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeThreeProject, renderCoverageReport } from './analyze-three-project.mjs';
import { generateWorkbench } from './generate-readonly-workbench.mjs';

export async function prepareWorkbench(project, output) {
  const projectRoot = await realpath(project);
  const root = output ? resolve(output) : join(projectRoot, '.game-tuning-workbench');
  if (root === projectRoot || projectRoot.startsWith(`${root}/`)) throw new Error('工作台输出目录不能覆盖游戏目录或其上级目录。');
  await mkdir(root, { recursive: true });
  // Reopening a live server preserves its in-memory model, drafts and receipts.
  try {
    const running = JSON.parse(await readFile(join(root, '.session.json'), 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(running.url || '')) throw new Error('Invalid session URL');
    const response = await fetch(`${running.url}api/flow/status`, { signal: AbortSignal.timeout(1000) });
    const status = await response.json();
    if (status.token === running.token && running.projectRoot === projectRoot) return { root, running };
  } catch { /* A stopped session is re-analyzed below. */ }
  const result = await analyzeThreeProject(projectRoot);
  const modelPath = join(root, 'analysis-model.json');
  await writeFile(modelPath, JSON.stringify(result.model, null, 2));
  await writeFile(join(root, 'analysis-report.md'), renderCoverageReport(result));
  await generateWorkbench(modelPath, root, { mode: 'apply' });
  return { root, projectRoot };
}

async function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', shell: false });
  child.on('error', () => console.log(`请在浏览器打开：${url}`));
}

async function main() {
  const argv = process.argv.slice(2); const project = argv.find(a => !a.startsWith('--'));
  if (!project || argv.includes('--help')) { console.log('用法：node scripts/open-workbench.mjs <游戏目录> [--no-open] [--output <工作台目录>]'); return; }
  const outputIndex = argv.indexOf('--output');
  const prepared = await prepareWorkbench(project, outputIndex >= 0 ? argv[outputIndex + 1] : null);
  const display = async url => { console.log(`工作台已打开：${url}`); if (!argv.includes('--no-open')) await openBrowser(url); };
  if (prepared.running) { await display(prepared.running.url); return; }
  const child = spawn(process.execPath, [join(import.meta.dirname, 'serve-workbench.mjs'), prepared.root, '--interactive', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  let buffer = ''; let opened = false;
  child.stdout.on('data', async chunk => {
    buffer += chunk;
    const match = buffer.match(/Game Tuning Workbench: (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (!match || opened) return; opened = true;
    try {
      const status = await fetch(`${match[1]}api/flow/status`).then(r => r.json());
      await writeFile(join(prepared.root, '.session.json'), JSON.stringify({ url: match[1], token: status.token, projectRoot: prepared.projectRoot }));
      await display(match[1]);
    } catch (error) { console.error(error.message); child.kill('SIGTERM'); }
  });
  child.on('error', error => { console.error(`无法启动：${error.message}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 0; });
  process.once('SIGINT', () => child.kill('SIGTERM')); process.once('SIGTERM', () => child.kill('SIGTERM'));
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
