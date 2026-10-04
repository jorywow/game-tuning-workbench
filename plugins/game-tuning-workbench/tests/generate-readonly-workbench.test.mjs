import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateReadonlyWorkbench } from "../scripts/generate-readonly-workbench.mjs";

const pluginRoot = join(import.meta.dirname, "..");

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("generates a dependency-free read-only workbench and copies safe image previews", async (context) => {
  const projectRoot = await temporaryDirectory("gtw-project-");
  const outputRoot = await temporaryDirectory("gtw-output-");
  context.after(() => Promise.all([
    rm(projectRoot, { recursive: true, force: true }),
    rm(outputRoot, { recursive: true, force: true }),
  ]));

  const model = JSON.parse(await readFile(join(pluginRoot, "examples", "minimal-threejs-model.json"), "utf8"));
  model.project.root = projectRoot;
  model.assets[0] = {
    ...model.assets[0],
    id: "asset.player-portrait",
    slot: "player.portrait",
    category: "player",
    label: "玩家头像",
    source: { file: "public/player.png", access: "editable" },
    preview: "public/player.png",
    usageSites: [],
    technicalContract: { kind: "image", acceptedMimeTypes: ["image/png"], width: 64, height: 64 },
  };
  model.worldview.cards[0].assetIds = ["asset.player-portrait"];
  model.dependencies[1].to = "asset.player-portrait";

  await mkdir(join(projectRoot, "public"), { recursive: true });
  await writeFile(join(projectRoot, "public", "player.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const modelPath = join(projectRoot, "model.json");
  await writeFile(modelPath, JSON.stringify(model), "utf8");

  const result = await generateReadonlyWorkbench(modelPath, outputRoot);
  assert.equal(result.metadata.mode, "readonly");
  assert.equal(result.metadata.copiedPreviews, 1);
  for (const filename of ["index.html", "styles.css", "app.js", "draft-model.js", "game-tuning-model.json", "workbench-meta.json"]) {
    await access(join(outputRoot, filename));
  }

  const generatedModel = JSON.parse(await readFile(join(outputRoot, "game-tuning-model.json"), "utf8"));
  assert.match(generatedModel.assets[0].preview, /^\.\/media\/asset\.player-portrait\.png$/);
  await access(join(outputRoot, generatedModel.assets[0].preview));

  const appSource = await readFile(join(outputRoot, "app.js"), "utf8");
  assert.match(appSource, /isDraftMode\(\) \? renderDraftTuning\(\) : renderReadonlyTuning\(\)/);
  assert.doesNotMatch(appSource, /applyChange|saveChange|writeSource/);
});

test("rejects non-Three.js models", async (context) => {
  const root = await temporaryDirectory("gtw-invalid-");
  context.after(() => rm(root, { recursive: true, force: true }));
  const model = JSON.parse(await readFile(join(pluginRoot, "examples", "minimal-threejs-model.json"), "utf8"));
  model.project.engine = "phaser";
  const modelPath = join(root, "model.json");
  await writeFile(modelPath, JSON.stringify(model), "utf8");
  await assert.rejects(() => generateReadonlyWorkbench(modelPath, join(root, "output")), /Only Three\.js/);
});
