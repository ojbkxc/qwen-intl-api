/**
 * 浏览器桥接模块
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

// 桥单例状态
let browser: any = null;
let ctx: any = null;
let page: any = null;
let currentToken: string = "";
let initPromise: Promise<void> | null = null;
// 串行化：同一时间只允许一个对话在页面上进行
let chatQueue: Promise<any> = Promise.resolve();
// 是否在对话完成后删除上游会话（环境变量 QWEN_AUTO_DELETE=false 可关闭）
let autoDeleteChat: boolean = process.env.QWEN_AUTO_DELETE !== "false";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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

/**
 * 初始化浏览器与页面（幂等）
 */
async function ensureBridge(token: string) {
  if (!chromium)
    throw new APIException(
      EX.API_REQUEST_FAILED,
      "playwright-core 未安装，浏览器桥不可用。请 npm i playwright-core 并安装 chromium"
    );
  // token 变化时重建页面
  if (page && token === currentToken) return;
  if (initPromise) {
    await initPromise;
    if (page && token === currentToken) return;
  }
  initPromise = (async () => {
    try {
      if (!browser) {
        browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
      }
      if (!ctx) {
        ctx = await browser.newContext({
          userAgent: UA,
          locale: "en-US",
        });
      }
      if (page) {
        try { await page.close(); } catch (err) {}
        page = null;
      }
      page = await ctx.newPage();
      await page.goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await page.waitForTimeout(8000);
      await ctx.addCookies([
        {
          name: "token",
          value: token,
          domain: ".qwen.ai",
          path: "/",
          httpOnly: true,
        },
      ]);
      await page.evaluate((t) => localStorage.setItem("token", t), token);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(10000);
      currentToken = token;
      logger.success("[browser-bridge] 页面就绪（登录态已注入）");
    } finally {
      initPromise = null;
    }
  })();
  await initPromise;
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
  await ensureBridge(token);

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
    throw new APIException(EX.API_REQUEST_FAILED, "页面输入框未找到");
  }
  await ta.click({ force: true });
  // fill() 直接设置 value（React 受控组件安全），比逐字 type 更可靠：
  // type 的 keydown 粒度下中文长文本会被输入框截断
  await ta.fill(prompt);
  await page.keyboard.press("Enter");

  // 等待 SSE 完整接收（页面响应捕获是整段的，等 resp.text() 返回）
  let sseBody = "";
  try {
    sseBody = await Promise.race([
      ssePromise,
      new Promise<string>((_, rej) =>
        setTimeout(
          () =>
            rej(
              new APIException(
                EX.API_REQUEST_FAILED,
                "等待上游响应超时（120s）"
              )
            ),
          120000
        )
      ),
    ]);
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
  // 串行排队，避免并发操作同一页面
  chatQueue = chatQueue.then(() => run, () => run);
  return chatQueue;
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
  return !!(browser && page);
}

export default {
  createCompletion,
  createCompletionStream,
  signinToken,
  bridgeAlive,
  deleteChat,
};
