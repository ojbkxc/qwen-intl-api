import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import pool from "@/api/controllers/account-pool.ts";
import bridge from "@/api/controllers/browser-bridge.ts";
import logger from "@/lib/logger.ts";

/**
 * 账号池管理接口（/pool）
 *
 * 保护：请求头需带 X-Admin-Token，与 QWEN_ADMIN_TOKEN 环境变量一致。
 * 未设置该环境变量时接口拒绝所有请求（安全默认）。
 */
function assertAdmin(request: Request) {
  const expected = process.env.QWEN_ADMIN_TOKEN;
  if (!expected)
    throw new Error("管理接口未启用：请设置环境变量 QWEN_ADMIN_TOKEN");
  const got =
    request.headers["x-admin-token"] ||
    String(request.headers.authorization || "").replace("Bearer ", "");
  if (got !== expected) throw new Error("管理令牌错误");
}

export default {
  prefix: "/pool",

  get: {
    /** 账号列表（脱敏） */
    "/list": async (request: Request) => {
      assertAdmin(request);
      return { accounts: pool.list() };
    },

    /** 用指定账号登录并测活（不写 token 缓存） */
    "/test": async (request: Request) => {
      assertAdmin(request);
      request.validate("query.email", _.isString);
      const acc = pool.find(request.query.email as string);
      if (!acc) return { live: false, error: "账号不存在" };
      try {
        const token = await bridge.signinToken(acc.email, acc.password);
        return { live: true, tokenPreview: token.slice(0, 24) + "..." };
      } catch (err: any) {
        return { live: false, error: String(err.message || err).slice(0, 200) };
      }
    },
  },

  post: {
    /** 添加账号 */
    "/add": async (request: Request) => {
      assertAdmin(request);
      request
        .validate("body.email", _.isString)
        .validate("body.password", _.isString);
      pool.add(request.body.email, request.body.password);
      return { ok: true };
    },

    /** 删除账号 */
    "/remove": async (request: Request) => {
      assertAdmin(request);
      request.validate("body.email", _.isString);
      pool.remove(request.body.email);
      return { ok: true };
    },

    /** 启用/禁用 */
    "/toggle": async (request: Request) => {
      assertAdmin(request);
      request
        .validate("body.email", _.isString)
        .validate("body.disabled", _.isBoolean);
      pool.setDisabled(request.body.email, request.body.disabled);
      return { ok: true };
    },

    /** 编辑账号：改 email 和/或密码 */
    "/edit": async (request: Request) => {
      assertAdmin(request);
      request
        .validate("body.email", _.isString)
        .validate("body.newEmail", _.isString)
        .validate("body.password", _.isString);
      pool.edit(request.body.email, request.body.newEmail, request.body.password);
      return { ok: true };
    },

    /** 批量导入：accounts 数组，每项 {email, password}（各账号密码可不同） */
    "/import-bulk": async (request: Request) => {
      assertAdmin(request);
      request.validate("body.accounts", _.isArray);
      const added: string[] = [];
      const skipped: string[] = [];
      for (const item of request.body.accounts) {
        const email = String(item?.email || "").trim();
        const password = String(item?.password || "");
        if (!email || !password) {
          skipped.push(email || "(invalid)");
          continue;
        }
        try {
          pool.add(email, password);
          added.push(email);
        } catch (err: any) {
          skipped.push(email);
        }
      }
      logger.info(
        `[account-pool] import-bulk: ${added.length} added, ${skipped.length} skipped`
      );
      return { added, skipped };
    },

    /** 批量导入（email 数组，统一密码）——旧格式兼容 */
    "/import": async (request: Request) => {
      assertAdmin(request);
      request
        .validate("body.emails", _.isArray)
        .validate("body.password", _.isString);
      const added: string[] = [];
      const skipped: string[] = [];
      for (const email of request.body.emails) {
        try {
          pool.add(String(email), request.body.password);
          added.push(String(email));
        } catch (err: any) {
          skipped.push(String(email));
        }
      }
      logger.info(
        `[account-pool] import: ${added.length} added, ${skipped.length} skipped`
      );
      return { added, skipped };
    },
  },
};
