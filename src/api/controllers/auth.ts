import crypto from "crypto";

import axios from "axios";
import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";

// 国外版域名
const BASE = "https://chat.qwen.ai";
// 前端版本号（对齐 qwen-chat-fe 0.2.91）
const VERSION = "0.2.91";
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json",
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
 * 校验邮箱格式
 */
function assertEmail(email: string) {
  if (!_.isString(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "邮箱格式不正确");
}

/**
 * 账号密码换取 token
 *
 * @param email 登录邮箱
 * @param password 登录密码（明文，内部 SHA-256 后提交）
 */
async function signin(email: string, password: string) {
  assertEmail(email);
  if (!_.isString(password) || !password)
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "密码不能为空");

  // 官网前端对密码做 SHA-256(小写hex) 后提交
  const passwordHash = crypto
    .createHash("sha256")
    .update(password, "utf8")
    .digest("hex");

  const result = await axios.post(
    `${BASE}/api/v1/auths/signin`,
    { email, password: passwordHash },
    {
      timeout: 30000,
      headers: {
        ...FAKE_HEADERS,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }
  );

  if (result.status !== 200 || !result.data || !result.data.token) {
    const detail = result.data && result.data.detail;
    const msg =
      (detail && (detail.details || detail.message || detail.code)) ||
      `登录失败，状态码 ${result.status}`;
    logger.warn(`[qwen-intl] signin failed: ${msg}`);
    throw new APIException(EX.API_TOKEN_EXPIRES, msg);
  }

  const { token, expires_at } = result.data;
  logger.success(`[qwen-intl] signin success for ${email}`);
  return { token, expires_at };
}

/**
 * 检测 token 是否存活
 *
 * 命中 GET /api/v1/auths/，返回 200 表示 token 有效
 */
async function checkToken(token: string) {
  if (!_.isString(token) || !token)
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "token不能为空");

  const result = await axios.get(`${BASE}/api/v1/auths/`, {
    timeout: 30000,
    headers: {
      ...FAKE_HEADERS,
      Cookie: `token=${token}`,
    },
    validateStatus: () => true,
  });
  return result.status === 200;
}

export default {
  signin,
  checkToken,
};