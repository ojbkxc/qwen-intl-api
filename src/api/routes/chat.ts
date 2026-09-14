import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import bridge from "@/api/controllers/browser-bridge.ts";
import auth from "@/api/controllers/auth.ts";

/**
 * 对话补全路由
 *
 * Authorization 支持两种形式：
 * - Bearer <qwen-token>：chat.qwen.ai 登录 token
 * - Bearer <email>:<password>：账号密码，自动登录换 token（推荐，token 过期可自动刷新）
 */
export default {
  prefix: "/v1/chat",

  post: {
    "/completions": async (request: Request) => {
      request
        .validate("body.messages", _.isArray)
        .validate("headers.authorization", _.isString);
      const raw = request.headers.authorization.replace("Bearer ", "");
      let token: string;
      // email:password 形式则自动登录
      if (raw.includes(":") && raw.includes("@")) {
        const [email, ...rest] = raw.split(":");
        token = await bridge.signinToken(email, rest.join(":"));
      } else {
        token = _.sample(raw.split(",")) as string;
      }
      const model = request.body.model || "qwen3.7-plus";
      const messages = request.body.messages;
      if (request.body.stream) {
        const stream = await bridge.createCompletionStream(
          model,
          messages,
          token
        );
        return new Response(stream, {
          type: "text/event-stream",
        });
      } else
        return await bridge.createCompletion(model, messages, token);
    },
  },
};