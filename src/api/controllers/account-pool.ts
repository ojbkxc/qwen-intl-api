/**
 * 服务端账号池（参照 ds2api 的设计思路）
 *
 * - 账号持久化在 data/accounts.json（容器卷），重启保留
 * - 每账号：email / password / token / disabled / failCount / lastUsed / lastError
 * - 调度：轮询（用过的移到队尾），跳过 disabled 与冷却中的账号
 * - 失败处理：连续失败进入冷却（60s 起指数退避，上限 30min），连续 10 次自动 disabled
 * - token 惰性刷新：请求到来时若 token 超过刷新间隔（默认 6h）则重新登录
 */

import path from "path";
import fs from "fs-extra";
import _ from "lodash";

import logger from "@/lib/logger.ts";

interface PoolAccount {
  email: string;
  password: string;
  /** 当前 token（运行时缓存，落盘时保留以便快速恢复） */
  token?: string;
  tokenTime?: number;
  /** 手动禁用 */
  disabled?: boolean;
  /** 连续失败计数 */
  failCount?: number;
  /** 冷却截止时间戳（ms） */
  cooldownUntil?: number;
  lastUsed?: number;
  lastError?: string;
}

const DATA_DIR = path.join(path.resolve(), "data");
const POOL_FILE = path.join(DATA_DIR, "accounts.json");
// token 刷新间隔（小时），环境变量 QWEN_TOKEN_REFRESH_HOURS 可调
const REFRESH_HOURS = Math.max(
  1,
  parseFloat(process.env.QWEN_TOKEN_REFRESH_HOURS || "6")
);
const MAX_FAIL_DISABLE = 10;
const COOLDOWN_BASE = 60_000;
const COOLDOWN_MAX = 30 * 60_000;

class AccountPool {
  private accounts: PoolAccount[] = [];
  /** 轮询指针 */
  private cursor = 0;
  private savePromise: Promise<void> = Promise.resolve();

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.pathExistsSync(POOL_FILE)) {
        this.accounts = fs.readJsonSync(POOL_FILE);
        logger.success(`[account-pool] loaded ${this.accounts.length} accounts`);
      } else {
        fs.ensureDirSync(DATA_DIR);
        this.accounts = [];
        logger.info("[account-pool] no accounts file, pool is empty");
      }
    } catch (err: any) {
      logger.error(`[account-pool] load failed: ${err.message}`);
      this.accounts = [];
    }
  }

  private save() {
    // 串行化写盘，避免并发写坏文件
    this.savePromise = this.savePromise
      .then(async () => {
        await fs.ensureDir(DATA_DIR);
        await fs.writeJson(POOL_FILE, this.accounts, { spaces: 2 });
      })
      .catch((err) => logger.error(`[account-pool] save failed: ${err.message}`));
    return this.savePromise;
  }

  /** 池是否为空 */
  get size() {
    return this.accounts.length;
  }

  /** 账号列表（脱敏，供管理接口展示） */
  list() {
    return this.accounts.map((a, idx) => ({
      index: idx,
      email: a.email,
      hasToken: !!a.token,
      tokenPreview: a.token ? a.token.slice(0, 24) + "..." : "",
      disabled: !!a.disabled,
      failCount: a.failCount || 0,
      cooling: !!(a.cooldownUntil && a.cooldownUntil > Date.now()),
      cooldownRemainSec: a.cooldownUntil
        ? Math.max(0, Math.ceil((a.cooldownUntil - Date.now()) / 1000))
        : 0,
      lastUsed: a.lastUsed || 0,
      lastError: a.lastError || "",
    }));
  }

  add(email: string, password: string) {
    if (this.accounts.some((a) => a.email === email))
      throw new Error(`账号已存在: ${email}`);
    this.accounts.push({ email, password });
    this.save();
    logger.success(`[account-pool] added ${email}`);
  }

  remove(email: string) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.email !== email);
    if (this.accounts.length === before) throw new Error(`账号不存在: ${email}`);
    this.save();
    logger.success(`[account-pool] removed ${email}`);
  }

  setDisabled(email: string, disabled: boolean) {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) throw new Error(`账号不存在: ${email}`);
    acc.disabled = disabled;
    if (disabled) acc.cooldownUntil = 0;
    this.save();
  }

  /**
   * 轮询取一个可用账号
   *
   * @param preferred 指定 email 则优先取该账号（忽略冷却，但仍受 disabled 限制）
   */
  acquire(preferred?: string): PoolAccount {
    if (this.accounts.length === 0)
      throw new Error("账号池为空，请先通过管理接口添加账号");
    if (preferred) {
      const acc = this.accounts.find((a) => a.email === preferred);
      if (!acc) throw new Error(`指定账号不存在: ${preferred}`);
      if (acc.disabled) throw new Error(`指定账号已禁用: ${preferred}`);
      return acc;
    }
    const now = Date.now();
    const n = this.accounts.length;
    for (let i = 0; i < n; i++) {
      const acc = this.accounts[this.cursor % n];
      this.cursor = (this.cursor + 1) % n;
      if (acc.disabled) continue;
      if (acc.cooldownUntil && acc.cooldownUntil > now) continue;
      acc.lastUsed = now;
      return acc;
    }
    throw new Error("账号池所有账号均在冷却或禁用中，请稍后重试");
  }

  /** 标记成功：清零失败计数与冷却 */
  markSuccess(email: string) {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;
    acc.failCount = 0;
    acc.cooldownUntil = 0;
    acc.lastError = "";
    this.save();
  }

  /** 标记失败：进入指数退避冷却；连续失败过多自动禁用 */
  markFailure(email: string, error?: string) {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;
    acc.failCount = (acc.failCount || 0) + 1;
    acc.lastError = String(error || "").slice(0, 200);
    const backoff = Math.min(
      COOLDOWN_MAX,
      COOLDOWN_BASE * Math.pow(2, acc.failCount - 1)
    );
    acc.cooldownUntil = Date.now() + backoff;
    if (acc.failCount >= MAX_FAIL_DISABLE) {
      acc.disabled = true;
      logger.warn(
        `[account-pool] ${email} failed ${acc.failCount} times, auto-disabled`
      );
    }
    this.save();
  }

  /** 更新 token 缓存 */
  setToken(email: string, token: string) {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;
    acc.token = token;
    acc.tokenTime = Date.now();
    this.save();
  }

  /** token 是否需要刷新（惰性判断，请求到来时调用） */
  needsRefresh(acc: PoolAccount): boolean {
    if (!acc.token) return true;
    const age = Date.now() - (acc.tokenTime || 0);
    return age > REFRESH_HOURS * 3600_000;
  }

  /** 池内是否有可用账号（不含指定 preferred） */
  hasAvailable(): boolean {
    const now = Date.now();
    return this.accounts.some(
      (a) => !a.disabled && (!a.cooldownUntil || a.cooldownUntil <= now)
    );
  }

  /** 按 email 找账号（内部用） */
  find(email: string) {
    return this.accounts.find((a) => a.email === email);
  }
}

export default new AccountPool();
