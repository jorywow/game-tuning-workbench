#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from './release-check.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const baseVersion = manifest.version.split("+")[0];
const releaseName = `${manifest.name}-marketplace-${baseVersion}`;
const releaseRoot = join(pluginRoot, "dist", releaseName);
const packagedPluginRoot = join(releaseRoot, "plugins", manifest.name);
const publicRelease = process.argv.includes('--public');
const issues = await checkRelease(pluginRoot, { publicRelease });
if (issues.length) throw new Error(`发布检查未通过：\n${issues.join('\n')}`);

if (!/^[a-z][a-z0-9-]+$/.test(manifest.name)) throw new Error("Plugin name is not distribution-safe.");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) throw new Error("Plugin version is not strict semver.");

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(packagedPluginRoot, { recursive: true });
const sourceEntries = await readdir(pluginRoot, { withFileTypes: true });
for (const entry of sourceEntries) {
  if (new Set(["dist", "node_modules", ".gtw-history", ".game-tuning-workbench", ".DS_Store"]).has(entry.name)) continue;
  await cp(join(pluginRoot, entry.name), join(packagedPluginRoot, entry.name), {
    recursive: true,
    filter(source) {
      return !new Set([".gtw-history", ".novice", ".game-tuning-workbench", "node_modules", "analysis-results", ".DS_Store"]).has(source.split(/[\\/]/).at(-1));
    },
  });
}

const marketplace = {
  name: "game-tuning-workbench-release",
  interface: { displayName: "Game Tuning Workbench Releases" },
  plugins: [{
    name: manifest.name,
    source: { source: "local", path: `./plugins/${manifest.name}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: manifest.interface.category,
  }],
};
const marketplacePath = join(releaseRoot, ".agents", "plugins", "marketplace.json");
await mkdir(dirname(marketplacePath), { recursive: true });
await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

await writeFile(join(releaseRoot, "release.json"), `${JSON.stringify({
  pluginId: manifest.name, version: baseVersion, marketplace: marketplace.name,
  distribution: publicRelease ? 'public-ready-not-published' : 'local-beta', createdAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');
const files = await listFiles(releaseRoot);
const checksums = [];
for (const path of files) {
  const contents = await readFile(join(releaseRoot, path));
  checksums.push(`${createHash("sha256").update(contents).digest("hex")}  ${path}`);
}
await writeFile(join(releaseRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");

console.log(`Release marketplace created: ${releaseRoot}`);
console.log(`Install with: codex plugin marketplace add ${releaseRoot}`);
console.log(`Then: codex plugin add ${manifest.name}@${marketplace.name}`);
