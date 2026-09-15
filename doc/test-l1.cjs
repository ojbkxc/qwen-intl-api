// L1 验证脚本：--disable-gpu + 杀动画 CSS，验证 bx-ua 仍有效 + CPU 是否降
// 在服务器 node 上直接跑（依赖项目 node_modules 里的 playwright-core）
// 用法: node test-l1.cjs <token>
const { chromium } = require('playwright-core');

const TOKEN = process.argv[2];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await ctx.newPage();
  console.log('[1] browser up with --disable-gpu');

  // 杀动画 CSS：domcontentloaded 后立即注入，抢在首帧动画前
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent =
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.addEventListener('DOMContentLoaded', () => {
      (document.head || document.documentElement).appendChild(style);
    });
  });
  console.log('[2] kill-animation CSS registered');

  await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  await ctx.addCookies([{ name: 'token', value: TOKEN, domain: '.qwen.ai', path: '/', httpOnly: true }]);
  await page.evaluate((t) => localStorage.setItem('token', t), TOKEN);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  console.log('[3] page ready (login injected)');

  // 注入完成后再补一刀（防 addInitScript 时序问题），并确认生效
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  const cssOk = await page.evaluate(() => {
    const el = document.createElement('div');
    el.style.animation = 'spin 1s linear infinite';
    document.body.appendChild(el);
    const a = getComputedStyle(el).animationName;
    el.remove();
    return a;
  });
  console.log('[4] animation computed =', JSON.stringify(cssOk), '(应为 "none")');

  // 对话测试
  let captured = '';
  const reqHandler = (req) => {
    const u = req.url();
    if (!captured && u.includes('/api/v2/chat/completions') && req.method() === 'POST') {
      const m = u.match(/[?&]chat_id=([0-9a-f-]{36})/i);
      if (m) captured = m[1];
    }
  };
  page.on('request', reqHandler);

  let sseResolve, sseReject;
  const ssePromise = new Promise((res, rej) => { sseResolve = res; sseReject = rej; });
  let settled = false;
  const handler = async (resp) => {
    try {
      if (resp.url().includes('/api/v2/chat/completions') && resp.request().method() === 'POST') {
        const ct = resp.headers()['content-type'] || '';
        const body = await resp.text();
        if (ct.includes('event-stream')) {
          if (!settled) { settled = true; sseResolve({ ok: true, len: body.length }); }
        } else if (body.includes('FAIL_SYS_USER_VALIDATE') && !settled) {
          settled = true; sseReject(new Error('PUNISHED: FAIL_SYS_USER_VALIDATE'));
        } else if (resp.status() >= 400 && !settled) {
          settled = true; sseReject(new Error('HTTP ' + resp.status() + ': ' + body.slice(0, 120)));
        }
      }
    } catch (e) {}
  };
  page.on('response', handler);

  const ta = await page.$('textarea');
  if (!ta) { console.log('NO TEXTAREA'); process.exit(1); }
  await ta.click({ force: true });
  await ta.fill('回答一个字：好');
  await page.keyboard.press('Enter');
  console.log('[5] prompt sent, waiting SSE...');

  const t0 = Date.now();
  try {
    const r = await Promise.race([
      ssePromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 120s')), 120000)),
    ]);
    console.log('[6] SSE OK, len=' + r.len + ', ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    console.log('[6] FAIL: ' + e.message);
  } finally {
    page.off('response', handler);
    page.off('request', reqHandler);
    if (captured) console.log('[7] chat_id=' + captured);
    // CPU 采样：3 秒内进程 CPU
    const { execSync } = require('child_process');
    try {
      const out = execSync("ps aux --sort=-pcpu | grep chrome | grep -v grep | awk '{print $3, $4, $11, $12, $13}'").toString();
      console.log('[8] chrome procs (cpu% mem% tags):\n' + out);
    } catch (e) { console.log('[8] ps failed: ' + e.message); }
    await browser.close();
    console.log('[9] browser closed');
    process.exit(0);
  }
})();
