#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

import { ApplyService } from "./apply-engine.mjs";
import { RuntimePreviewService } from "./runtime-preview-service.mjs";
import { NoviceService } from "./novice-service.mjs";
import { captureSmoke } from "./smoke-evidence.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function parseCli(argv) {
  const positional = [];
  let port = 4179;
  let host = "127.0.0.1";
  let projectRoot = null;
  let verifyBuild = true;
  let help = false;
  let interactive = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") port = Number(argv[++index]);
    else if (argument === "--host") host = argv[++index];
    else if (argument === "--allow-source-write") projectRoot = argv[++index];
    else if (argument === "--skip-build-verification") verifyBuild = false;
    else if (argument === "--interactive") interactive = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer between 0 and 65535.");
  if ((projectRoot || interactive) && !new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("Source-write mode can only bind to a loopback host.");
  }
  return { root: positional[0], port, host, projectRoot, verifyBuild, help, interactive };
}

function helpText() {
  return `Usage: node scripts/serve-workbench.mjs <workbench-directory> [--host 127.0.0.1] [--port 4179]\n`
    + `       [--allow-source-write <exact-project-root>] [--skip-build-verification]\n\n`
    + `Source writes are disabled unless an exact project root is explicitly approved.\n`;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw Object.assign(new Error("Expected application/json."), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 12_000_000) throw Object.assign(new Error("Request body is too large."), { code: "BODY_TOO_LARGE" });
  }
  return JSON.parse(body || "{}");
}

function errorStatus(error) {
  if (error?.code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (error?.code === "BODY_TOO_LARGE") return 413;
  if (new Set(["SOURCE_DRIFT", "PROPOSAL_CHANGED", "PROPOSAL_EXPIRED", "INVALID_RECEIPT_STATE"]).has(error?.code)) return 409;
  if (new Set(["CONFIRMATION_REQUIRED", "UNSAFE_PATH", "PROJECT_ROOT_MISMATCH"]).has(error?.code)) return 403;
  if (new Set(["PROPOSAL_NOT_FOUND", "INVALID_RECEIPT", "INVALID_EVIDENCE"]).has(error?.code)) return 404;
  if (new Set(["PREVIEW_START_FAILED", "PREVIEW_UNSUPPORTED", "PREVIEW_ERROR"]).has(error?.code)) return 422;
  return 400;
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const expectedHost = request.headers.host;
  if (new URL(origin).host !== expectedHost) throw Object.assign(new Error("Cross-origin application requests are blocked."), { code: "UNSAFE_PATH" });
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  if (args.help || !args.root) {
    console.log(helpText());
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const root = resolve(args.root);
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) throw new Error("Workbench path must be a directory.");
  const [model, metadata] = await Promise.all([
    readFile(join(root, "game-tuning-model.json"), "utf8").then(JSON.parse),
    readFile(join(root, "workbench-meta.json"), "utf8").then(JSON.parse),
  ]);
  let applyService = null;
  let previewService = null;
  if (metadata.mode === "apply") {
    try {
      applyService = await new ApplyService({
        model,
        projectRoot: resolve(args.projectRoot ?? model.project.root),
        workbenchRoot: root,
        verifyBuild: args.verifyBuild,
        writeEnabled: Boolean(args.projectRoot),
      }).initialize();
    } catch (error) {
      if (args.projectRoot) throw error;
      console.warn(`Confirmation preview disabled: ${error.message}`);
    }
    try {
      previewService = await new RuntimePreviewService({
        model,
        projectRoot: resolve(model.project.root),
      }).initialize();
    } catch (error) {
      console.warn(`Runtime preview disabled: ${error.message}`);
    }
  } else if (args.projectRoot) {
    throw new Error("Source-write mode requires an apply-mode workbench.");
  }

  const novice = args.interactive ? await new NoviceService({ model, workbenchRoot: root, canAuthorize: true, verifyBuild: args.verifyBuild }).initialize() : null;
  let previewBusy = false;
  const server = createServer(async (request, response) => {
    try {
      if (novice && request.headers.host !== `127.0.0.1:${server.address().port}`) throw new Error("不接受其他地址的请求。");
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Frame-Options', 'DENY');
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const decodedPath = decodeURIComponent(url.pathname);
      if (decodedPath.startsWith('/api/flow/')) {
        if (!novice) { sendJson(response, 403, { error: '请用一句话启动入口打开工作台。' }); return; }
        if (request.method !== 'GET') {
          assertSameOrigin(request);
          if (request.headers['x-gtw-token'] !== novice.token) throw new Error('页面会话已更新，请刷新后重试。');
        }
        const body = request.method === 'POST' ? await readJsonBody(request) : {};
        const action = decodedPath.slice('/api/flow/'.length);
        if (previewBusy && request.method === 'POST') throw new Error('试玩正在启动或检查，请稍候。');
        let result;
        if (action === 'status' && request.method === 'GET') result = novice.status();
        else if (action === 'permission' && request.method === 'POST') result = novice.authorize(body.choice);
        else if (action === 'drafts' && ['GET', 'POST'].includes(request.method)) result = await novice.drafts(request.method === 'POST' ? body.drafts : undefined);
        else if (action === 'candidates' && ['GET', 'POST'].includes(request.method)) result = await novice.candidates(request.method === 'POST' ? body : undefined);
        else if (action === 'prepare' && request.method === 'POST') result = await novice.startJob(body.drafts);
        else if (action === 'job' && request.method === 'GET') result = novice.jobs.get(url.searchParams.get('id')) ?? { state: 'failed', message: '服务已重新启动，请再次准备修改。' };
        else if (action === 'proposal' && request.method === 'GET') result = await novice.latestProposal();
        else if (action === 'receipts' && request.method === 'GET') result = await novice.receipts();
        else if (action === 'apply' && request.method === 'POST') { result = await novice.apply(body); if (previewService) previewService.model = novice.model; }
        else if (action === 'revert' && request.method === 'POST') { if (body.confirmed !== true) throw new Error('请先确认撤销。'); result = await novice.revert(body.id); if (previewService) previewService.model = novice.model; }
        else if (action === 'verify' && request.method === 'POST') result = await novice.verify(body.id, body.checks);
        else if (['preview', 'smoke'].includes(action) && request.method === 'POST') {
          if (!previewService) throw new Error('这个游戏尚未配置启动方式，请让 Codex 帮你接入。');
          if (previewBusy || novice.busy) throw new Error('正在处理，请稍候再试。');
          previewBusy = true;
          try {
            if (action === 'smoke') {
              const receipt = await novice.receipt(body.id);
              if (!['applied', 'verified'].includes(receipt.state)) throw new Error('只能检查已经保存的修改。');
              for (const patch of receipt.patches) if (await readFile(await novice.boundFile(patch.path), 'utf8') !== patch.after) throw new Error('游戏已变化，请检查最新修改记录。');
              const status = await previewService.startBaseline();
              receipt.smoke = await captureSmoke({ url: status.session.baselineUrl, outputRoot: root, id: receipt.id });
              await novice.putReceipt(receipt); result = receipt;
            } else if (body.proposalId) {
              if (!/^[a-f0-9-]{36}$/.test(body.proposalId)) throw new Error('修改方案无效。');
              const proposal = JSON.parse(await readFile(join(novice.store, `proposal-${body.proposalId}.json`), 'utf8'));
              result = await previewService.startPrepared(proposal.changeSet, proposal.patches);
            } else if (body.drafts && Object.keys(body.drafts).length) {
              const drafts = novice.canonicalDrafts(body.drafts);
              const { buildDraftChangeSet } = await import('../assets/workbench/draft-model.js');
              result = await previewService.start({ ...buildDraftChangeSet(novice.model, drafts), state: 'proposed' });
            } else result = await previewService.startBaseline();
          } finally { previewBusy = false; }
        } else { sendJson(response, 404, { error: '没有找到这个操作。' }); return; }
        sendJson(response, 200, result); return;
      }
      // Unified sessions expose only the token-protected flow API; legacy routes remain for old clients.
      if (novice && decodedPath.startsWith('/api/')) { sendJson(response, 404, { error: '请刷新到新版工作台。' }); return; }
      if (decodedPath === "/api/status" && request.method === "GET") {
        sendJson(response, 200, {
          mode: metadata.mode,
          proposalEnabled: Boolean(applyService),
          applyEnabled: applyService?.writeEnabled === true,
          projectName: model.project.name,
          buildVerification: applyService?.writeEnabled ? args.verifyBuild : false,
          runtimePreviewEnabled: Boolean(previewService),
        });
        return;
      }
      if (decodedPath === "/api/preview/status" && request.method === "GET") {
        sendJson(response, 200, previewService ? await previewService.status() : { active: false, sourceUnchanged: true, session: null });
        return;
      }
      if (decodedPath === "/api/preview/start" && request.method === "POST") {
        assertSameOrigin(request);
        if (!previewService) {
          sendJson(response, 403, { error: "Runtime preview service is not available.", code: "APPLY_DISABLED" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await previewService.start(body.changeSet));
        return;
      }
      if (decodedPath === "/api/preview/stop" && request.method === "POST") {
        assertSameOrigin(request);
        if (!previewService) {
          sendJson(response, 200, { active: false, sourceUnchanged: true, session: null });
          return;
        }
        sendJson(response, 200, await previewService.stop());
        return;
      }
      if (decodedPath === "/api/receipts" && request.method === "GET") {
        if (!applyService) {
          sendJson(response, 200, []);
          return;
        }
        sendJson(response, 200, await applyService.listReceipts());
        return;
      }
      if (decodedPath.startsWith("/api/receipts/")) {
        assertSameOrigin(request);
        if (!applyService) {
          sendJson(response, 403, { error: "Verification service is not available.", code: "APPLY_DISABLED" });
          return;
        }
        const parts = decodedPath.split("/").filter(Boolean);
        const receiptId = parts[2];
        if (parts.length === 3 && request.method === "GET") {
          sendJson(response, 200, await applyService.readReceipt(receiptId));
          return;
        }
        if (parts[3] === "verification" && parts.length === 4 && request.method === "POST") {
          sendJson(response, 200, await applyService.updatePlaytest(receiptId, await readJsonBody(request)));
          return;
        }
        if (parts[3] === "evidence" && parts.length === 4 && request.method === "POST") {
          sendJson(response, 200, await applyService.addEvidence(receiptId, await readJsonBody(request)));
          return;
        }
        if (parts[3] === "evidence" && parts.length === 5 && request.method === "GET") {
          const result = await applyService.getEvidence(receiptId, parts[4]);
          response.writeHead(200, {
            "content-type": result.evidence.mimeType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          createReadStream(result.path).pipe(response);
          return;
        }
        if (parts[3] === "evidence" && parts.length === 5 && request.method === "DELETE") {
          sendJson(response, 200, await applyService.deleteEvidence(receiptId, parts[4]));
          return;
        }
        sendJson(response, 404, { error: "Receipt API endpoint not found.", code: "NOT_FOUND" });
        return;
      }
      if (decodedPath.startsWith("/api/changesets/")) {
        assertSameOrigin(request);
        if (!applyService) {
          sendJson(response, 403, { error: "Confirmation service is not available.", code: "APPLY_DISABLED" });
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" });
          return;
        }
        const body = await readJsonBody(request);
        if (decodedPath === "/api/changesets/propose") {
          sendJson(response, 200, await applyService.propose(body.changeSet));
          return;
        }
        if (decodedPath === "/api/changesets/apply") {
          if (!applyService.writeEnabled) {
            sendJson(response, 403, { error: "Source-write service is not enabled.", code: "APPLY_DISABLED" });
            return;
          }
          if (request.headers["x-gtw-confirm"] !== body.digest) {
            sendJson(response, 403, { error: "Confirmation digest header is required.", code: "CONFIRMATION_REQUIRED" });
            return;
          }
          const receipt = await applyService.apply(body);
          if (previewService) previewService.model = applyService.model;
          sendJson(response, 200, receipt);
          return;
        }
        if (decodedPath === "/api/changesets/revert") {
          if (!applyService.writeEnabled) {
            sendJson(response, 403, { error: "Source-write service is not enabled.", code: "APPLY_DISABLED" });
            return;
          }
          const receipt = await applyService.revert(body.receiptId);
          if (previewService) previewService.model = applyService.model;
          sendJson(response, 200, receipt);
          return;
        }
        sendJson(response, 404, { error: "API endpoint not found.", code: "NOT_FOUND" });
        return;
      }
      if (!new Set(["GET", "HEAD"]).has(request.method ?? "GET")) {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Method not allowed");
        return;
      }
      const requestedPath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      if (requestedPath.split("/").some((part) => part.startsWith("."))) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const filePath = resolve(join(root, requestedPath));
      if (!isInside(root, filePath)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch (error) {
      if ((request.url ?? "").startsWith("/api/")) {
        sendJson(response, errorStatus(error), { error: error.message, code: error.code ?? "REQUEST_FAILED" });
        return;
      }
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error?.code === "ENOENT" ? "Not found" : "Internal server error");
    }
  });

  server.on("error", (error) => {
    console.error(`Workbench server failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(args.port, args.host, () => {
    console.log(`Game Tuning Workbench: http://${args.host}:${server.address().port}/`);
    console.log(`Confirmation preview: ${applyService ? "enabled" : "disabled"}`);
    console.log(`Source apply: ${applyService?.writeEnabled ? "enabled for the approved project root" : "disabled"}`);
    console.log("Press Control+C to stop.");
  });
  const shutdown = async () => {
    await previewService?.stop().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`Workbench server failed: ${error.message}`);
  process.exitCode = 1;
});
