import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDraftChangeSet } from "../assets/workbench/draft-model.js";
import { generateApplyWorkbench } from "../scripts/generate-apply-workbench.mjs";

const pluginRoot = join(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "gtw-apply-server-"));
const projectRoot = join(temporaryRoot, "project");
const workbenchRoot = join(temporaryRoot, "workbench");
const sourcePath = join(projectRoot, "src", "game", "GameTuningConfig.js");
const modelPath = join(temporaryRoot, "model.json");
const port = 43179;

const parameter = {
  id: "tuning.player-max-health",
  ownerId: "system.player",
  group: "controls",
  label: "最大生命",
  description: "玩家最大生命。",
  playerMeaning: { lower: "更脆弱", higher: "更耐打" },
  valueType: "integer",
  unit: null,
  currentValue: 100,
  defaultValue: 100,
  safeRange: { min: 50, max: 300, step: 5 },
  control: "slider",
  sourceBinding: { file: "src/game/GameTuningConfig.js", symbol: "DEFAULT_TUNING.player.maxHealth", lineHint: 3, access: "editable" },
  previewBinding: { consumer: "PlayerController.maxHealth", mode: "live" },
  effects: { direct: ["改变玩家最大生命"], indirect: [], excluded: ["不改变武器伤害"] },
  confidence: "confirmed",
  evidenceRefs: ["evidence.player-health"],
};

const model = {
  schemaVersion: "0.1.0",
  modelId: "project.apply-server-fixture",
  project: { name: "apply-server-fixture", root: projectRoot, engine: "three", coverage: 1, entryPoints: ["src/main.js"], runtimeRoots: ["src/game"], limitations: [] },
  evidence: [],
  worldview: { cards: [] },
  coreGameplay: { summary: "fixture", loopSteps: [], rules: [] },
  tuningParameters: [parameter],
  assets: [],
  dependencies: [],
};

let child;
try {
  await mkdir(join(projectRoot, "src", "game"), { recursive: true });
  await writeFile(sourcePath, "export const DEFAULT_TUNING = Object.freeze({\n  player: Object.freeze({\n    maxHealth: 100,\n  }),\n});\n", "utf8");
  await writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  await generateApplyWorkbench(modelPath, workbenchRoot);

  child = spawn(process.execPath, [
    join(pluginRoot, "scripts", "serve-workbench.mjs"),
    workbenchRoot,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--allow-source-write", projectRoot,
    "--skip-build-verification",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolvePromise, rejectPromise) => {
    let startupError = "";
    const timer = setTimeout(() => rejectPromise(new Error("Server startup timed out.")), 10_000);
    child.stderr.on("data", (chunk) => { startupError += String(chunk); });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Game Tuning Workbench")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.on("exit", (code) => rejectPromise(new Error(`Server exited early with ${code}. ${startupError}`)));
  });

  const origin = `http://127.0.0.1:${port}`;
  const status = await fetch(`${origin}/api/status`).then((response) => response.json());
  assert.equal(status.applyEnabled, true);

  const changeSet = {
    ...buildDraftChangeSet(model, {
      [parameter.id]: { targetId: parameter.id, before: 100, after: 125 },
    }, "2026-08-31T00:00:00.000Z"),
    state: "proposed",
  };
  const proposalResponse = await fetch(`${origin}/api/changesets/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changeSet }),
  });
  assert.equal(proposalResponse.status, 200);
  const proposal = await proposalResponse.json();

  const applyResponse = await fetch(`${origin}/api/changesets/apply`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gtw-confirm": proposal.digest },
    body: JSON.stringify({ proposalId: proposal.proposalId, digest: proposal.digest, confirmed: true }),
  });
  assert.equal(applyResponse.status, 200);
  let receipt = await applyResponse.json();
  assert.match(await readFile(sourcePath, "utf8"), /maxHealth: 125,/);

  const receiptHistory = await fetch(`${origin}/api/receipts`).then((response) => response.json());
  assert.equal(receiptHistory.length, 1);
  assert.equal(receiptHistory[0].playtest.checks.length, 2);

  const passedChecks = receipt.playtest.checks.map((check) => ({ ...check, status: "passed" }));
  const prematureVerification = await fetch(`${origin}/api/receipts/${receipt.receiptId}/verification`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "passed", checks: passedChecks, notes: "" }),
  });
  assert.equal(prematureVerification.status, 400);

  const evidenceResponse = await fetch(`${origin}/api/receipts/${receipt.receiptId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "试玩截图",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    }),
  });
  assert.equal(evidenceResponse.status, 200);
  receipt = await evidenceResponse.json();
  const evidenceId = receipt.playtest.evidence[0].evidenceId;
  const servedEvidence = await fetch(`${origin}/api/receipts/${receipt.receiptId}/evidence/${evidenceId}`);
  assert.equal(servedEvidence.status, 200);
  assert.equal(servedEvidence.headers.get("content-type"), "image/png");

  const verificationResponse = await fetch(`${origin}/api/receipts/${receipt.receiptId}/verification`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "passed", checks: passedChecks, notes: "试玩通过" }),
  });
  assert.equal(verificationResponse.status, 200);
  receipt = await verificationResponse.json();
  assert.equal(receipt.state, "verified");

  const hiddenHistory = await fetch(`${origin}/.gtw-history/${receipt.receiptId}/receipt.json`);
  assert.equal(hiddenHistory.status, 404);

  const revertResponse = await fetch(`${origin}/api/changesets/revert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiptId: receipt.receiptId }),
  });
  assert.equal(revertResponse.status, 200);
  assert.match(await readFile(sourcePath, "utf8"), /maxHealth: 100,/);
  console.log("Apply server integration passed: status -> propose -> apply -> history -> evidence -> verify -> hidden history -> revert");
} finally {
  child?.kill("SIGTERM");
  await rm(temporaryRoot, { recursive: true, force: true });
}
