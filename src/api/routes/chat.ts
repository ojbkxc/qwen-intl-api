import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import bridge from "@/api/controllers/browser-bridge.ts";
import auth from "@/api/controllers/auth.ts";
import pool from "@/api/controllers/account-pool.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";

/**
 * 对话补全路由
 *
 * Authorization 支持三种形式：
 * - 不传：从服务端账号池轮询取号（推荐，账号经 /pool 管理接口维护）
 * - Bearer <qwen-token>：chat.qwen.ai 登录 token
 * - Bearer <email>:<password>：账号密码，自动登录换 token
 */
export default {
  prefix: "/v1/chat",

  post: {
    "/completions": async (request: Request) => {
      request.validate("body.messages", _.isArray);
      const model = request.body.model || "qwen3.7-plus";
      const messages = request.body.messages;

      // 未带 Authorization：走账号池
      const rawHeader = request.headers.authorization;
      if (!rawHeader) {
        const acc = pool.acquire();
        const { email, password } = acc;
        // 有缓存 token 且未过期直接用；否则登录换新
        let token = acc.token;
        if (!token || pool.needsRefresh(acc)) {
          token = await bridge.signinToken(email, password);
        }
        pool.setToken(email, token);
        try {
          return await runCompletion(model, messages, token, request.body.stream);
        } catch (err: any) {
          // 请求失败标记账号，换下一个账号重试一次
          pool.markFailure(email, err.message);
          if (!pool.hasAvailable()) throw err;
          const next = pool.acquire();
          let nextToken = next.token || (await bridge.signinToken(next.email, next.password));
          pool.setToken(next.email, nextToken);
          const resp = await runCompletion(model, messages, nextToken, request.body.stream);
          pool.markSuccess(next.email);
          return resp;
        }
      }

      const raw = rawHeader.replace("Bearer ", "");
      let token: string;
      // email:password 形式则自动登录
      if (raw.includes(":") && raw.includes("@")) {
        const [email, ...rest] = raw.split(":");
        token = await bridge.signinToken(email, rest.join(":"));
      } else {
        token = _.sample(raw.split(",")) as string;
      }
      return await runCompletion(model, messages, token, request.body.stream);
    },
  },
};

async function runCompletion(model: string, messages: any[], token: string, stream?: boolean) {
  if (stream) {
    const s = await bridge.createCompletionStream(model, messages, token);
    return new Response(s, { type: "text/event-stream" });
  }
  return await bridge.createCompletion(model, messages, token);
}