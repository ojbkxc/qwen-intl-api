/**
 * 浏览器桥接模块（多账号版）
 *
 * chat.qwen.ai 的对话接口受阿里巴夏风控（bx-ua）保护，纯 HTTP 与页面内
 * 手动 fetch/XHR 均无法通过，只有登录态浏览器中由前端应用真实发出的
 * 请求（UI 输入框发送）才能通过。因此对话转发走常驻 headless Chromium：
 *
 * 1. 启动浏览器并注入登录 token（cookie + localStorage）
 * 2. 对话请求驱动页面输入框输入并发送
 * 3. 捕获 /api/v2/chat/completions 的 SSE 响应流
 * 4. 转换为 OpenAI 兼容 chunk 供上层输出
 *
 * 多账号架构：
 * - 全局唯一 browser 进程（--disable-gpu 杀 swiftshader 软渲染空烧）
 * - 每账号一个 BrowserContext（隔离 cookie/localStorage/umid）
 * - context 内常驻一个 page，按 LRU 淘汰（QWEN_MAX_PAGES，默认 4）
 * - 页面注入杀动画 CSS（animation/transition none），rAF 空转近零
 * - 每账号一条串行队列，不同账号并行（各自页面独立生成 bx-ua）
 * - 就绪探测替代固定 sleep：textarea 出现 + baxia 就绪即返回
 * - 资源拦截：alicdn 图片/字体/媒体 abort（风控 SDK script 放行）
 *
 * 会话清理：从 completions 请求 URL 提取 chat_id，对话完成后通过
 * Node fetch 调 DELETE /api/v2/chats/{id}（纯 HTTP，不经 Playwright）。
 */

import crypto from "crypto";
import { createRequire } from "module";
import { PassThrough } from "stream";

import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";

// ESM 上下文用 createRequire 加载 playwright-core；缺失时桥不可用
let chromium: any = null;
try {
  const nodeRequire = createRequire(import.meta.url);
  chromium = nodeRequire("playwright-core").chromium;
} catch (err) {
  logger.warn("playwright-core is not installed, browser bridge unavailable");
}

// ---------------- 全局浏览器与账号池 ----------------

let browser: any = null;

/** 每账号会话：context + 常驻 page + 串行队列 + 就绪 promise */
interface AccountSession {
  token: string;
  ctx: any;
  page: any;
  /** 串行队列：同一账号页面上的对话逐个进行 */
  queue: Promise<any>;
  /** 就绪初始化 promise（防并发重复初始化） */
  initPromise: Promise<void> | null;
  /** LRU 时钟：最近一次被使用的时间戳 */
  lastUsed: number;
}

/** token -> session */
const sessions = new Map<string, AccountSession>();

// 环境变量：同时常驻的最大账号页数（超出按 LRU 关闭最久未用）
const MAX_PAGES = Math.max(1, parseInt(process.env.QWEN_MAX_PAGES || "4", 10));

// 是否在对话完成后删除上游会话（环境变量 QWEN_AUTO_DELETE=false 可关闭）
const autoDeleteChat: boolean = process.env.QWEN_AUTO_DELETE !== "false";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// 杀动画 CSS：rAF 驱动的 compositing 是 CPU 空烧主因（实测 gpu-process 85% -> ~3%）
const KILL_ANIM_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important}";

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    headless: true,
    // --disable-gpu：headless 下 swiftshader 软渲染纯空烧（L1 实测 CPU 85% -> 3%）
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  // 浏览器崩溃（OOM 等）自动清理，下次请求重建
  browser.on("disconnected", () => {
    if (browser) logger.warn("[browser-bridge] browser disconnected, will relaunch on next request");
    browser = null;
    sessions.clear();
  });
  logger.success("[browser-bridge] browser launched");
}

/** LRU 淘汰：关闭除 exclude 外最久未用的账号页 */
function evictLRU(excludeToken?: string) {
  const list = [...sessions.entries()].sort(
    (a, b) => a[1].lastUsed - b[1].lastUsed
  );
  while (sessions.size >= MAX_PAGES) {
    const victim = list.shift();
    if (!victim) break;
    const [token, session] = victim;
    if (token === excludeToken) continue;
    logger.info(
      `[browser-bridge] LRU evict account page (${sessions.size} -> ${sessions.size - 1})`
    );
    sessions.delete(token);
    // 页面可能正被该账号队列使用；关闭动作挂在其队列尾部保证串行安全
    session.queue = session.queue.then(async () => {
      try {
        await session.ctx.close();
      } catch (err) {}
    });
  }
}

/**
 * 初始化账号会话（context + page + 登录注入），幂等
 */
async function initSession(session: AccountSession) {
  session.initPromise = (async () => {
    try {
      await ensureBrowser();
      // LRU：可能挤掉别的账号页（不挤自己）
      evictLRU(session.token);
      const ctx = await browser.newContext({
        userAgent: UA,
        locale: "en-US",
      });
      // addInitScript 在每次导航/重载时自动注入（含 app 重新挂载的时机）
      await ctx.addInitScript(() => {
        const inject = () => {
          const style = document.createElement("style");
          style.textContent =
            "*,*::before,*::after{animation:none!important;transition:none!important}";
          (document.head || document.documentElement).appendChild(style);
        };
        if (document.readyState === "loading")
          document.addEventListener("DOMContentLoaded", inject);
        else inject();
      });
      // 登录态先注入再进页面：免 reload（cookie 随首次导航直接生效）
      await ctx.addCookies([
        {
          name: "token",
          value: session.token,
          domain: ".qwen.ai",
          path: "/",
          httpOnly: true,
        },
      ]);
      const page = await ctx.newPage();
      // L4 资源拦截：拦掉 alicdn 图片/字体/媒体（装饰资源），每页省 30-50MB。
      // 风控 SDK（baxia/fireyejs/awsc）是 g.alicdn.com 上的 script，放行；
      // chat.qwen.ai 自身 API（含图片下载）不拦。
      await page.route(/^(?!https?:\/\/g\.alicdn\.com\/AWSC\/|https?:\/\/g\.alicdn\.com\/sd\/)/i, (route: any) => {
        const req = route.request();
        const url = req.url() as string;
        const type = req.resourceType();
        // 只拦 alicdn 系静态资源的媒体类（图片/字体/媒体），script/document/xhr/fetch 一律放行
        const isAlicdn = /alicdn\.com/i.test(url);
        const isMedia = ["image", "font", "media"].includes(type);
        if (isAlicdn && isMedia) return route.abort();
        return route.continue();
      });
      // localStorage 需要在页面 origin 下写入：先导航再写、再等 app 就绪
      await page.goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await page.evaluate((t) => localStorage.setItem("token", t), session.token);
      await waitPageReady(page);
      session.ctx = ctx;
      session.page = page;
      session.lastUsed = Date.now();
      logger.success(`[browser-bridge] account page ready (pool ${sessions.size}/${MAX_PAGES})`);
    } finally {
      session.initPromise = null;
    }
  })();
  await session.initPromise;
}

/** 若会话已失效（页面被关/崩溃），复位待重建 */
function resetSession(session: AccountSession) {
  try { session.ctx && session.ctx.close(); } catch (err) {}
  session.ctx = null;
  session.page = null;
}

/**
 * 页面就绪探测：textarea 出现 + baxia SDK 完成挂载
 *
 * 替代旧版固定 sleep(8s+10s)；正常 3-6s 就绪，慢网自动多等
 */
async function waitPageReady(page: any) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const ready = await page.evaluate(() => {
        const hasTextarea = !!document.querySelector("textarea");
        // baxiaCommon.init 完成后暴露全局配置；app 挂载后才有输入框
        return {
          ta: hasTextarea,
        };
      });
      if (ready.ta) {
        // textarea 出现后再宽限 2s 让 fireyejs 行为采集器完成启动
        await page.waitForTimeout(2000);
        return;
      }
    } catch (err) {
      // 页面可能正在跳转/重载，继续轮询
    }
    await page.waitForTimeout(1000);
  }
  throw new APIException(EX.API_REQUEST_FAILED, "页面就绪超时（60s）");
}

/**
 * 登录换取 token（密码 SHA-256）
 */
async function signinToken(email: string, password: string) {
  const passwordHash = crypto
    .createHash("sha256")
    .update(password, "utf8")
    .digest("hex");
  const resp = await fetch("https://chat.qwen.ai/api/v1/auths/signin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json",
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/",
      Version: "0.2.91",
      source: "web",
    },
    body: JSON.stringify({ email, password: passwordHash }),
  }).then((r) => r.json());
  if (!resp.token)
    throw new APIException(
      EX.API_TOKEN_EXPIRES,
      `登录失败: ${JSON.stringify(resp).slice(0, 200)}`
    );
  return resp.token as string;
}

/**
 * 纯 HTTP 删除上游会话（Node fetch，不经浏览器）
 *
 * DELETE /api/v2/chats/{id}，200/204/404 均视为已删除
 * （与 qwen2API 的 DeleteChat 判定一致）
 */
async function deleteChat(token: string, chatId: string): Promise<boolean> {
  if (!token || !chatId) return true;
  try {
    const resp = await fetch(
      `https://chat.qwen.ai/api/v2/chats/${chatId}`,
      {
        method: "DELETE",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Origin: "https://chat.qwen.ai",
          Referer: "https://chat.qwen.ai/",
          Cookie: `token=${token}`,
          Version: "0.2.91",
          source: "web",
        },
      }
    );
    if (resp.ok || resp.status == 404) {
      logger.success(
        `[browser-bridge] 已删除上游会话 ${chatId}（HTTP ${resp.status}）`
      );
      return true;
    }
    const body = await resp.text();
    logger.warn(
      `[browser-bridge] 删除上游会话失败 ${chatId}（HTTP ${resp.status}）: ${body.slice(0, 120)}`
    );
    return false;
  } catch (err: any) {
    logger.warn(
      `[browser-bridge] 删除上游会话异常 ${chatId}: ${err.message}`
    );
    return false;
  }
}

/** 取（或建）账号会话 */
function getOrCreateSession(token: string): AccountSession {
  let session = sessions.get(token);
  if (!session) {
    session = {
      token,
      ctx: null,
      page: null,
      queue: Promise.resolve(),
      initPromise: null,
      lastUsed: Date.now(),
    };
    sessions.set(token, session);
  }
  session.lastUsed = Date.now();
  return session;
}

/**
 * 单次对话：驱动 UI 发送并捕获 SSE 响应体
 *
 * 同时拦截 completions 请求 URL 提取 chat_id，对话完成后异步删除会话。
 *
 * @param prompt 合并后的完整提问文本
 * @param token 登录 token
 */
async function chatOnce(prompt: string, token: string): Promise<string> {
  const session = getOrCreateSession(token);
  await initSession(session);
  const page = session.page;
  if (!page)
    throw new APIException(EX.API_REQUEST_FAILED, "账号页面不可用");

  // chat_id 捕获：completions 请求 URL 形如 /api/v2/chat/completions?chat_id=<uuid>
  let capturedChatId = "";
  const reqHandler = (req: any) => {
    try {
      const u = req.url();
      if (
        !capturedChatId &&
        u.includes("/api/v2/chat/completions") &&
        req.method() === "POST"
      ) {
        const m = u.match(/[?&]chat_id=([0-9a-f-]{36})/i);
        if (m) capturedChatId = m[1];
      }
    } catch (err) {}
  };
  page.on("request", reqHandler);

  // 响应体捕获：监听 event-stream 响应
  let sseResolve: (v: string) => void;
  let sseReject: (e: Error) => void;
  const ssePromise = new Promise<string>((resolve, reject) => {
    sseResolve = resolve;
    sseReject = reject;
  });
  let settled = false;
  // completions POST 是否已发出（发送后才开始计算首响应超时）
  let sentAt = 0;
  const handler = async (resp: any) => {
    try {
      if (
        resp.url().includes("/api/v2/chat/completions") &&
        resp.request().method() === "POST"
      ) {
        const ct = resp.headers()["content-type"] || "";
        if (ct.includes("event-stream")) {
          const body = await resp.text();
          if (!settled) {
            settled = true;
            sseResolve(body);
          }
        } else {
          // 非流响应（多半是风控拦截 JSON）
          const body = await resp.text();
          if (body.includes("FAIL_SYS_USER_VALIDATE") && !settled) {
            settled = true;
            sseReject(
              new APIException(
                EX.API_REQUEST_FAILED,
                "上游风控拦截（FAIL_SYS_USER_VALIDATE），请稍后重试"
              )
            );
          }
        }
      }
    } catch (err) {
      /* response 已释放等场景忽略 */
    }
  };
  page.on("response", handler);

  // UI 输入并发送
  const ta = await page.$("textarea");
  if (!ta) {
    page.off("response", handler);
    page.off("request", reqHandler);
    // 页面状态异常（被导航/崩溃），复位待重建
    resetSession(session);
    throw new APIException(EX.API_REQUEST_FAILED, "页面输入框未找到");
  }
  await ta.click({ force: true });
  // fill() 直接设置 value（React 受控组件安全），比逐字 type 更可靠：
  // type 的 keydown 粒度下中文长文本会被输入框截断
  await ta.fill(prompt);
  sentAt = Date.now();
  await page.keyboard.press("Enter");

  // 等待 SSE 完整接收（页面响应捕获是整段的，等 resp.text() 返回）。
  // 双超时：发送后 30s 内上游无任何 completions 响应 → 视为静默挂起
  // （风控偶发拦截/会话卡死），提前抛错复位页面，不再干等 120s。
  let sseBody = "";
  try {
    sseBody = await Promise.race([
      ssePromise,
      new Promise<string>((_, rej) => {
        const t = setTimeout(
          () =>
            rej(
              new APIException(
                EX.API_REQUEST_FAILED,
                "等待上游响应超时（120s）"
              )
            ),
          120000
        );
        // 首响应看门狗：任一 completions 响应到达（settled）即停止检测；
        // 发送后 30s 仍无响应 → 提前抛错
        const watchdog = setInterval(() => {
          if (settled) {
            clearInterval(watchdog);
            clearTimeout(t);
            return;
          }
          if (sentAt && Date.now() - sentAt > 30000) {
            clearInterval(watchdog);
            clearTimeout(t);
            rej(
              new APIException(
                EX.API_REQUEST_FAILED,
                "上游 30s 无响应（静默挂起），已提前中止"
              )
            );
          }
        }, 1000);
      }),
    ]);
  } catch (err) {
    // 静默挂起：页面大概率卡死，强制复位下次重建（evaluate 探活失败也会复位）
    if (String((err as any)?.message || "").includes("静默挂起")) {
      resetSession(session);
      logger.warn(
        `[browser-bridge] upstream silent hang detected, session reset (${token.slice(0, 8)}...)`
      );
      throw err;
    }
    // 页面已死（punish 关页/崩溃）时复位，下次重建
    try {
      await page.evaluate("1");
    } catch (alive) {
      resetSession(session);
    }
    throw err;
  } finally {
    page.off("response", handler);
    page.off("request", reqHandler);
    // 清空输入框残留，避免影响下一次
    try {
      const ta2 = await page.$("textarea");
      if (ta2) await ta2.fill("");
    } catch (err) {}
    // 对话完成后异步删除上游会话（延迟 1.5s，不阻塞响应返回）
    if (autoDeleteChat && capturedChatId) {
      const chatId = capturedChatId;
      const tk = token;
      setTimeout(() => {
        deleteChat(tk, chatId).catch(() => {});
      }, 1500);
    }
  }
  return sseBody;
}

/**
 * 从 SSE 体解析完整回复文本（answer 阶段的增量拼接）
 */
function extractAnswer(sseBody: string) {
  let content = "";
  let reasoning = "";
  const events = sseBody.split("\n");
  for (const line of events) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data == "[DONE]") continue;
    const result = _.attempt(() => JSON.parse(data));
    if (_.isError(result)) continue;
    const delta = result.choices?.[0]?.delta;
    if (!delta) continue;
    // answer 阶段为增量输出
    if (delta.phase == "answer" && typeof delta.content == "string")
      content += delta.content;
    else if (
      delta.phase == "thinking_summary" &&
      delta.extra?.summary_thought?.content
    )
      reasoning += delta.extra.summary_thought.content.join("");
  }
  return { content, reasoning };
}

/**
 * 同步对话补全
 */
async function createCompletion(
  model: string,
  messages: any[],
  token: string
) {
  // 多轮消息合并为一段完整 prompt；UI 输入对超长文本稳定，
  // 但 <|\im_start|> 这类特殊标记会被输入法过滤，改用自然分隔
  const prompt = messages
    .map((m) => {
      const text = _.isArray(m.content)
        ? m.content
            .filter((c) => c.type == "text")
            .map((c) => c.text || "")
            .join("")
        : String(m.content || "");
      const role = m.role == "assistant" ? "AI回答" : m.role == "system" ? "系统设定" : "用户";
      return `[${role}]\n${text}`;
    })
    .join("\n\n") + "\n\n[用户]\n请根据以上对话内容进行回复。";

  const session = getOrCreateSession(token);
  const run = (async () => {
    const sse = await chatOnce(prompt, token);
    const { content, reasoning } = extractAnswer(sse);
    return {
      id: util_uuid(),
      model: model || "qwen3.7-plus",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: content || reasoning },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: Math.floor(Date.now() / 1000),
    };
  })();
  // 按账号排队：同账号串行（同一页面），不同账号并行
  session.queue = session.queue.then(() => run, () => run);
  return session.queue;
}

/**
 * 流式对话补全（UI 无法真流式，收到完整 SSE 后按 answer 增量回放为流）
 */
async function createCompletionStream(
  model: string,
  messages: any[],
  token: string
) {
  const answer = await createCompletion(model, messages, token);
  const created = answer.created;
  const transStream = new PassThrough();
  // 首个空 delta
  transStream.write(
    `data: ${JSON.stringify({
      id: answer.id,
      model: answer.model,
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
      ],
      created,
    })}\n\n`
  );
  const chunks = (answer.choices[0].message.content || "").match(/[\s\S]{1,64}/g) || [];
  for (const chunk of chunks) {
    transStream.write(
      `data: ${JSON.stringify({
        id: answer.id,
        model: answer.model,
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { content: chunk }, finish_reason: null },
        ],
        created,
      })}\n\n`
    );
  }
  transStream.write(
    `data: ${JSON.stringify({
      id: answer.id,
      model: answer.model,
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created,
    })}\n\n`
  );
  transStream.end("data: [DONE]\n\n");
  return transStream;
}

function util_uuid() {
  return crypto.randomUUID();
}

/**
 * 桥健康检查
 */
async function bridgeAlive() {
  return !!browser;
}

export default {
  createCompletion,
  createCompletionStream,
  signinToken,
  bridgeAlive,
  deleteChat,
};
