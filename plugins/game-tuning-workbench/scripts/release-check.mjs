import { readFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkRelease(root, { publicRelease = false } = {}) {
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  const problems = [];
  if (publicRelease) {
    if (!manifest.author?.name || /local developer|todo|待确认/i.test(manifest.author.name)) problems.push('需要确认公开作者名称');
    try { await access(join(root, 'LICENSE')); } catch { problems.push('需要作者选择许可证并提供 LICENSE'); }
    if (!/^https:\/\/(github\.com|gitlab\.com)\//.test(manifest.repository || '')) problems.push('需要确认公开代码仓库');
  }
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['dist', 'node_modules', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { problems.push(`分发内容不能包含符号链接：${path}`); continue; }
      if (entry.isDirectory()) { if (entry.name !== 'analysis-results') await scan(path); continue; }
      if (/\.(?:md|json|ya?ml|m?js|ts|html|css)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) problems.push(`发现个人绝对路径：${path}`);
        if (/(?:sk-[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{30,})/.test(text)) problems.push(`发现疑似密钥：${path}`);
      }
    }
  }
  await scan(root); return problems;
}
if (process.argv[1] && import.meta.url.endsWith('/release-check.mjs') && process.argv[1].endsWith('release-check.mjs')) {
  const errors = await checkRelease(join(import.meta.dirname, '..'), { publicRelease: process.argv.includes('--public') });
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; } else console.log('Release checks passed.');
}
