#!/usr/bin/env node

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = join(pluginRoot, "assets", "workbench");
const TEMPLATE_FILES = ["index.html", "styles.css", "app.js", "draft-model.js", "novice.js", "novice.css", "novice-copy.js"];
const SAFE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

function safeFilePart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "asset";
}

function validateModel(model) {
  if (!model || typeof model !== "object") throw new Error("Model must be a JSON object.");
  if (model.project?.engine !== "three") throw new Error("Only Three.js game models are supported.");
  for (const field of ["evidence", "tuningParameters", "assets", "dependencies"]) {
    if (!Array.isArray(model[field])) throw new Error(`Model field ${field} must be an array.`);
  }
  if (!Array.isArray(model.worldview?.cards)) throw new Error("Model needs worldview.cards.");
  if (!Array.isArray(model.coreGameplay?.loopSteps) || !Array.isArray(model.coreGameplay?.rules)) {
    throw new Error("Model needs coreGameplay.loopSteps and coreGameplay.rules.");
  }
}

async function copySafePreviews(model, outputRoot) {
  const projectRoot = resolve(model.project.root);
  const mediaRoot = join(outputRoot, "media");
  let copied = 0;
  const skipped = [];

  for (const asset of model.assets) {
    if (asset.technicalContract?.kind !== "image" || !asset.source?.file) continue;
    const extension = extname(asset.source.file).toLowerCase();
    if (!SAFE_IMAGE_EXTENSIONS.has(extension)) {
      skipped.push({ assetId: asset.id, reason: "unsupported-image-extension" });
      asset.preview = null;
      continue;
    }
    const sourcePath = resolve(projectRoot, asset.source.file);
    if (!isInside(projectRoot, sourcePath)) {
      skipped.push({ assetId: asset.id, reason: "path-outside-project" });
      asset.preview = null;
      continue;
    }
    try {
      const sourceStats = await stat(sourcePath);
      if (!sourceStats.isFile() || sourceStats.size > MAX_PREVIEW_BYTES) {
        skipped.push({ assetId: asset.id, reason: "preview-too-large-or-not-file" });
        asset.preview = null;
        continue;
      }
      await mkdir(mediaRoot, { recursive: true });
      const targetName = `${safeFilePart(asset.id)}${extension}`;
      await copyFile(sourcePath, join(mediaRoot, targetName));
      asset.preview = `./media/${targetName}`;
      copied += 1;
    } catch (error) {
      skipped.push({ assetId: asset.id, reason: error?.code === "ENOENT" ? "preview-missing" : "preview-copy-failed" });
      asset.preview = null;
    }
  }
  return { copied, skipped };
}

export async function generateWorkbench(rawModelPath, rawOutputPath, { mode = "readonly" } = {}) {
  if (!new Set(["readonly", "draft", "apply"]).has(mode)) throw new Error(`Unsupported workbench mode: ${mode}`);
  const modelPath = resolve(rawModelPath);
  const outputRoot = resolve(rawOutputPath);
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  validateModel(model);

  await mkdir(outputRoot, { recursive: true });
  for (const filename of TEMPLATE_FILES) {
    await copyFile(join(templateRoot, filename), join(outputRoot, filename));
  }
  const previewResult = await copySafePreviews(model, outputRoot);
  await writeFile(join(outputRoot, "game-tuning-model.json"), `${JSON.stringify(model, null, 2)}\n`, "utf8");

  const metadata = {
    mode,
    generatedAt: new Date().toISOString(),
    sourceModel: basename(modelPath),
    projectName: model.project.name,
    copiedPreviews: previewResult.copied,
    skippedPreviews: previewResult.skipped,
  };
  await writeFile(join(outputRoot, "workbench-meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { outputRoot, metadata };
}

export async function generateReadonlyWorkbench(rawModelPath, rawOutputPath) {
  return generateWorkbench(rawModelPath, rawOutputPath, { mode: "readonly" });
}

function parseCli(argv) {
  const positional = [];
  let output = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") output = argv[++index];
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  return { modelPath: positional[0], output, help };
}

function helpText() {
  return `Usage: node scripts/generate-readonly-workbench.mjs <model.json> --output <directory>\n\n`
    + `Creates a dependency-free, read-only workbench. Existing unrelated files in the output directory are preserved.\n`;
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    if (args.help || !args.modelPath || !args.output) {
      console.log(helpText());
      process.exitCode = args.help ? 0 : 1;
      return;
    }
    const result = await generateReadonlyWorkbench(args.modelPath, args.output);
    console.error(`Read-only workbench generated: ${result.outputRoot}`);
    console.error(`Image previews copied: ${result.metadata.copiedPreviews}`);
  } catch (error) {
    console.error(`Workbench generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
