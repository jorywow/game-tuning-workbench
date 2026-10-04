import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// A smoke check is evidence of loading/rendering, never proof of gameplay correctness.
export async function captureSmoke({ url, outputRoot, id }) {
  let browser;
  try {
    const playwright = process.env.GTW_PLAYWRIGHT_MODULE
      ? await import(pathToFileURL(process.env.GTW_PLAYWRIGHT_MODULE).href)
      : await import('playwright');
    try { browser = await playwright.chromium.launch({ headless: true }); }
    catch (error) {
      if (!error.message.includes("Executable doesn't exist")) throw error;
      // Reuse an installed official Chrome when Playwright's optional download is absent.
      browser = await playwright.chromium.launch({ headless: true, channel: 'chrome' });
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; const warnings = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const location = msg.location().url || '';
      const message = `${msg.text()}${location ? ` (${location})` : ''}`;
      if (/\/favicon\.(ico|png)(?:\?|$)/.test(location)) warnings.push(message);
      else errors.push(message);
    });
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    // Only known start controls, not arbitrary links or destructive actions.
    const start = page.getByRole('button', { name: /^(开始游戏|开始试玩|开始|Start Game|Play)$/i }).first();
    let started = false;
    if (await start.isVisible().catch(() => false)) { await start.click({ timeout: 2000 }); started = true; }
    await page.waitForTimeout(1500);
    const visibleCanvas = await page.locator('canvas').evaluateAll(nodes => nodes.some(n => n.width > 0 && n.height > 0 && n.getBoundingClientRect().width > 0));
    await mkdir(join(outputRoot, 'evidence'), { recursive: true });
    const screenshot = `evidence/${id}.png`;
    await page.screenshot({ path: join(outputRoot, screenshot), fullPage: true });
    const passed = response?.ok() && errors.length === 0 && visibleCanvas;
    return { status: passed ? 'passed' : 'failed', screenshot, errors, warnings, visibleCanvas, started, capturedAt: new Date().toISOString(), message: passed ? `页面与画布已加载，未发现运行错误；${started ? '已尝试点击开始按钮' : '未自动进入游戏操作'}，玩法和手感仍需要你试玩确认。` : '页面、画布或运行日志检查未通过，请查看详情。' };
  } catch (error) {
    return { status: 'not-run', message: '自动截图暂不可用。请让 Codex 安装工作台的浏览器检查依赖，再重试。', detail: error.message };
  } finally { await browser?.close(); }
}
