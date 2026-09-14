import { PassThrough } from "stream";
import _ from "lodash";
import axios from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "qwen";
// 国外版接口域名
const BASE = "https://chat.qwen.ai";
// 前端版本号（对齐 qwen-chat-fe 0.2.91）
const VERSION = "0.2.91";
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/event-stream, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: BASE,
  Referer: `${BASE}/`,
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Version: VERSION,
  source: "web",
};

/**
 * 生成随机请求ID
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * 构造国外版对话请求体
 */
function buildRequestBody(chatId: string, model: string, messages: any[]) {
  const timestamp = util.unixTimestamp();
  return {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId: chatId,
    parentId: "",
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: messages.map((msg, idx) => ({
      id: null,
      fid: idx === 0 ? util.uuid(false) : null,
      parentId: null,
      childrenIds: [],
      role: msg.role || "user",
      content:
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text || "")
              .join(""),
      user_action: "chat",
      files: [],
      timestamp,
      models: [model],
      model: "",
      chat_type: "t2t",
      feature_config: {
        thinking_enabled: true,
        output_schema: "phase",
        research_mode: "normal",
        auto_thinking: true,
        thinking_mode: "Auto",
        thinking_format: "summary",
        auto_search: true,
      },
      extra: { meta: { subChatType: "t2t" } },
      sub_chat_type: "t2t",
      parent_id: null,
    })),
    timestamp,
  };
}

/**
 * 发送国外版对话流请求
 *
 * 注意：该接口受 qwen.ai 巴夏风控（bx-ua）保护，纯 HTTP 请求会命中
 * FAIL_SYS_USER_VALIDATE 人机校验。当前保留实现，待后续接入浏览器运行时后启用。
 */
async function requestChatStream(
  token: string,
  body: any
): Promise<PassThrough> {
  const resp = await axios.post(`${BASE}/api/v2/chat/completions`, body, {
    timeout: 120000,
    responseType: "stream",
    headers: {
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Cookie: `token=${token}`,
      "X-Request-Id": generateRequestId(),
      "X-Accel-Buffering": "no",
    },
    validateStatus: () => true,
  });

  if (resp.status !== 200) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[qwen-intl] 对话接口响应错误: [${resp.status}]`
    );
  }

  return resp.data;
}

/**
 * 从流接收完整的消息内容
 *
 * 国外版 SSE 为 OpenAI 兼容 chunk：
 * data: {"choices":[{"delta":{"content":"..."}}],"response_id":"...","selected_model_id":"...", ...}
 */
async function receiveStream(stream: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = {
      id: "",
      model: MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return resolve(data);
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (result.response_id) data.id = result.response_id;
        const delta = result.choices?.[0]?.delta;
        const content = delta?.content || "";
        if (typeof content === "string" && content)
          data.choices[0].message.content += content;
        if (delta?.finish_reason || result.done) return resolve(data);
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
    stream.once("end", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将国外版 OpenAI 兼容流直接透传为 gpt 兼容流
 *
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(stream: any, endCallback?: Function) {
  const created = util.unixTimestamp();
  const transStream = new PassThrough();
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model: MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") {
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
        return;
      }
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      const delta = result.choices?.[0]?.delta;
      const content = delta?.content || "";
      if (typeof content === "string" && content) {
        const out = {
          id: result.response_id || "",
          model: result.selected_model_id || MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { content }, finish_reason: null },
          ],
          created,
        };
        !transStream.closed &&
          transStream.write(`data: ${JSON.stringify(out)}\n\n`);
      }
      if (delta?.finish_reason || result.done) {
        const out = {
          id: result.response_id || "",
          model: result.selected_model_id || MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        };
        !transStream.closed &&
          transStream.write(`data: ${JSON.stringify(out)}\n\n`);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback(result.response_id);
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  return transStream;
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式
 * @param token 国外版登录 token
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  token: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);
    const body = buildRequestBody(util.uuid(false), model, messages);
    const stream = await requestChatStream(token, body);
    const streamStartTime = util.timestamp();
    const answer = await receiveStream(stream);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );
    return answer;
  })().catch((err) => {
    if (retryCount < 1) {
      logger.error(`Stream response error: ${err.message}`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return createCompletion(model, messages, token, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式
 * @param token 国外版登录 token
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  token: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);
    const body = buildRequestBody(util.uuid(false), model, messages);
    const stream = await requestChatStream(token, body);
    const streamStartTime = util.timestamp();
    return createTransStream(stream, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    });
  })().catch((err) => {
    if (retryCount < 1) {
      logger.error(`Stream response error: ${err.message}`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return createCompletionStream(model, messages, token, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

export default {
  createCompletion,
  createCompletionStream,
  tokenSplit,
};