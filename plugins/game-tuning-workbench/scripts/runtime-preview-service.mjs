import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { patchNumericBinding, validateProposedChangeSet } from "./apply-engine.mjs";

function assert(condition, message, code = "PREVIEW_ERROR") {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePromise(address.port));
    });
  });
}

async function detectDevCommand(projectRoot, port) {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const script = packageJson.scripts?.dev ? "dev" : packageJson.scripts?.start ? "start" : null;
  assert(script, "The target project needs a dev or start script for runtime preview.", "PREVIEW_UNSUPPORTED");
  const candidates = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  let command = "npm";
  for (const [lockfile, candidate] of candidates) {
    if (await pathExists(join(projectRoot, lockfile))) { command = candidate; break; }
  }
  const args = command === "npm"
    ? ["run", script, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : ["run", script, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
  return { command, args };
}

async function copyProject(sourceRoot, destinationRoot) {
  const ignored = new Set([".git", ".gtw-history", ".gtw-preview", ".game-tuning-workbench", ".codex", ".agents", ".env", ".env.local", "dist", "node_modules"]);
  await mkdir(destinationRoot, { recursive: true });
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const path = relative(sourceRoot, source);
      return path === "" || !path.split(sep).some((part) => ignored.has(part));
    },
  });
  const dependencies = join(sourceRoot, "node_modules");
  if (await pathExists(dependencies)) await symlink(dependencies, join(destinationRoot, "node_modules"), "dir");
}

async function sourceFingerprints(projectRoot, operations) {
  const files = [...new Set(operations.map((operation) => operation.sourceBinding.file))];
  const fingerprints = {};
  for (const file of files) {
    const candidate = resolve(projectRoot, file);
    assert(isInside(projectRoot, candidate), `Preview source path escapes the project: ${file}.`, "UNSAFE_PATH");
    const actual = await realpath(candidate);
    assert(isInside(projectRoot, actual), `Preview source resolves outside the project: ${file}.`, "UNSAFE_PATH");
    assert((await stat(actual)).isFile(), `Preview source is not a file: ${file}.`, "UNSAFE_PATH");
    fingerprints[file] = hash(await readFile(actual));
  }
  return fingerprints;
}

async function patchDraftCopy(draftRoot, operations) {
  const grouped = new Map();
  for (const operation of operations) {
    const list = grouped.get(operation.sourceBinding.file) ?? [];
    list.push(operation);
    grouped.set(operation.sourceBinding.file, list);
  }
  for (const [file, fileOperations] of grouped) {
    const target = resolve(draftRoot, file);
    assert(isInside(draftRoot, target), `Draft path escapes the preview copy: ${file}.`, "UNSAFE_PATH");
    let source = await readFile(target, "utf8");
    for (const operation of fileOperations) {
      source = patchNumericBinding(source, operation.sourceBinding, operation.before, operation.after);
    }
    await writeFile(target, source, "utf8");
  }
}

function launch(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let output = "";
  const append = (chunk) => { output = `${output}${chunk}`.slice(-20_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, output: () => output };
}

async function waitForPreview(url, process, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assert(process.child.exitCode === null, `Preview server exited early.\n${process.output()}`, "PREVIEW_START_FAILED");
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch { /* Wait for the server to bind. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw Object.assign(new Error(`Preview server did not become ready.\n${process.output()}`), { code: "PREVIEW_START_FAILED" });
}

async function stopChild(process) {
  if (!process?.child || process.child.exitCode !== null) return;
  process.child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      process.child.kill("SIGKILL");
      resolvePromise();
    }, 3000);
    process.child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

export class RuntimePreviewService {
  constructor({ model, projectRoot }) {
    this.model = model;
    this.projectRoot = projectRoot;
    this.session = null;
  }

  async initialize() {
    this.projectRoot = await realpath(this.projectRoot);
    const modelRoot = await realpath(this.model.project.root);
    assert(modelRoot === this.projectRoot, "Preview project root does not match the analyzed model root.", "PROJECT_ROOT_MISMATCH");
    await access(join(this.projectRoot, "package.json"));
    return this;
  }

  async sourceUnchanged(session = this.session) {
    if (!session) return true;
    const current = await sourceFingerprints(this.projectRoot, session.changeSet.operations);
    return Object.entries(session.sourceFingerprints).every(([file, fingerprint]) => current[file] === fingerprint);
  }

  publicSession(session = this.session) {
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      state: session.state,
      startedAt: session.startedAt,
      operationCount: session.changeSet.operations.length,
      baselineUrl: session.baselineUrl,
      draftUrl: session.draftUrl,
      summary: session.changeSet.summary,
      changeSet: session.changeSet,
    };
  }

  async status() {
    const session = this.publicSession();
    if (!session) return { active: false, sourceUnchanged: true, session: null };
    return { active: true, sourceUnchanged: await this.sourceUnchanged(), session };
  }

  async start(candidate) {
    const changeSet = validateProposedChangeSet(this.model, { ...candidate, state: "proposed" });
    return this.startPrepared(changeSet);
  }

  async startBaseline() {
    return this.startPrepared({ operations: [], summary: "当前游戏（没有修改）" });
  }

  async startPrepared(changeSet, patches = null) {
    await this.stop();
    const sourceHashes = await sourceFingerprints(this.projectRoot, changeSet.operations);
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "gtw-runtime-preview-")));
    const baselineRoot = join(temporaryRoot, "baseline");
    const draftRoot = join(temporaryRoot, "draft");
    const baselinePort = await freePort();
    const draftPort = await freePort();
    let baselineProcess = null;
    let draftProcess = null;
    try {
      await Promise.all([copyProject(this.projectRoot, baselineRoot), copyProject(this.projectRoot, draftRoot)]);
      if (patches) {
        for (const patch of patches) {
          const target = resolve(draftRoot, patch.path);
          assert(isInside(draftRoot, target) && await realpath(target) === target, "Unsafe preview path", "UNSAFE_PATH");
          assert(await readFile(target, "utf8") === patch.before, "游戏已变化，请重新准备修改。", "SOURCE_DRIFT");
          await writeFile(target, patch.after, "utf8");
        }
      } else await patchDraftCopy(draftRoot, changeSet.operations);
      const [baselineCommand, draftCommand] = await Promise.all([
        detectDevCommand(baselineRoot, baselinePort),
        detectDevCommand(draftRoot, draftPort),
      ]);
      baselineProcess = launch(baselineCommand.command, baselineCommand.args, baselineRoot);
      draftProcess = launch(draftCommand.command, draftCommand.args, draftRoot);
      const baselineUrl = `http://127.0.0.1:${baselinePort}/`;
      const draftUrl = `http://127.0.0.1:${draftPort}/`;
      await Promise.all([
        waitForPreview(baselineUrl, baselineProcess),
        waitForPreview(draftUrl, draftProcess),
      ]);
      this.session = {
        sessionId: `preview.${randomUUID().replaceAll("-", "")}`,
        state: "running",
        startedAt: new Date().toISOString(),
        temporaryRoot,
        baselineRoot,
        draftRoot,
        baselineUrl,
        draftUrl,
        baselineProcess,
        draftProcess,
        sourceFingerprints: sourceHashes,
        changeSet,
      };
      assert(await this.sourceUnchanged(), "Target source changed while starting the preview.", "SOURCE_DRIFT");
      return await this.status();
    } catch (error) {
      await Promise.all([stopChild(baselineProcess), stopChild(draftProcess)]);
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async stop() {
    const session = this.session;
    if (!session) return { active: false, sourceUnchanged: true, session: null };
    const unchanged = await this.sourceUnchanged(session);
    this.session = null;
    await Promise.all([stopChild(session.baselineProcess), stopChild(session.draftProcess)]);
    await rm(session.temporaryRoot, { recursive: true, force: true });
    return { active: false, sourceUnchanged: unchanged, session: { ...this.publicSession(session), state: "stopped" } };
  }
}
