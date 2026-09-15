# Qwen 国际版 Free API 服务

面向 [Qwen 国外版](https://chat.qwen.ai) 的 OpenAI 兼容 API 服务（国内版为通义千问 tongyi.aliyun.com，本项目对应 chat.qwen.ai）。

## 声明

仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！

## 当前状态

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 账号密码登录换 token | ✅ 可用 | `POST /auth/signin` |
| token 存活检测 | ✅ 可用 | `POST /token/check` |
| 对话补全 | ✅ 可用 | 内置 headless Chromium 浏览器桥，绕过巴夏风控（bx-ua） |
| 多账号并发 | ✅ 可用 | 每账号独立浏览器上下文，不同账号并行，LRU 页池 |
| 会话自动清理 | ✅ 可用 | 每次对话完成后自动删除上游会话，不留痕迹 |

## 原理

chat.qwen.ai 的对话接口受阿里巴夏风控（bx-ua）保护，纯 HTTP 请求会命中 `FAIL_SYS_USER_VALIDATE` 人机校验。本项目内置 Playwright + headless Chromium：

1. 全局共享一个浏览器进程，**每个账号一个独立 BrowserContext**（cookie/localStorage 隔离），页面常驻复用
2. 对话请求驱动页面真实 UI 输入发送（风控只放行页面自身发出的请求）
3. 拦截捕获 `/api/v2/chat/completions` 的 SSE 响应流，转换为 OpenAI 兼容格式
4. 从请求 URL 提取 `chat_id`，对话完成后通过纯 HTTP 调 `DELETE /api/v2/chats/{id}` 删除上游会话

多账号并发：同一账号的对话串行排队；**不同账号各自页面并行处理**（独立生成风控签名）。账号页按 LRU 淘汰，超出 `QWEN_MAX_PAGES` 时自动关闭最久未用的账号页，下次请求自动重建。

资源优化（v1.1.0）：`--disable-gpu` + 禁用页面动画 + 拦截 CDN 装饰资源，空闲 CPU 从 ~100% 降至 ~2%。

## 接入准备

使用一个 chat.qwen.ai 的账号（邮箱 + 密码），通过登录接口换取 token：

```
POST /auth/signin
{"email": "you@example.com", "password": "your_password"}
```

响应中的 `token` 即后续对话接口的 `Authorization: Bearer <token>`。

> 登录密码在客户端做 SHA-256 后提交，服务端不存储任何账号信息。

也可以直接在 `Authorization` 头中传 `email:password` 格式，服务端会自动登录换取 token（推荐，token 可自动刷新）。

## Docker 部署

```shell
docker pull ojbkxc/qwen-intl-api:latest
```

或使用 docker-compose（见 `docker-compose.yml`）：

```shell
docker-compose up -d
```

镜像已内置 chromium 浏览器与全部系统依赖，开箱即用。

## 本地运行

```shell
npm i
npm run build
npx playwright-core install chromium   # 安装浏览器
npm start
```

默认端口 `8001`（可通过 `configs/dev/service.yml` 修改）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QWEN_AUTO_DELETE` | `true` | 对话完成后是否自动删除上游会话，设为 `false` 关闭 |
| `QWEN_MAX_PAGES` | `4` | 同时常驻的最大账号页数（每页约 200~260MB 内存），超出按 LRU 淘汰最久未用的账号 |

## 接口列表

### 登录

**POST /auth/signin**

请求：
```json
{
    "email": "you@example.com",
    "password": "your_password"
}
```

响应：
```json
{
    "token": "eyJhbGciOi...",
    "token_type": "Bearer",
    "expires_at": 1791990561
}
```

### token 存活检测

**POST /token/check**

请求：
```json
{ "token": "eyJhbGciOi..." }
```

响应：
```json
{ "live": true }
```

### 对话补全

与 OpenAI [chat-completions-api](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) 兼容。

**POST /v1/chat/completions**

header：`Authorization: Bearer [token 或 email:password]`

请求：
```json
{
    "model": "qwen3.7-plus",
    "messages": [
        { "role": "user", "content": "你是谁？" }
    ],
    "stream": false
}
```

> 可用模型：`qwen3.7-plus`、`qwen3.8-max`、`qwen3.7-max`、`qwen3.6-plus`、`qwen3.5-plus`、`qwen3.5-omni-plus`

## 已知限制

1. 对话依赖浏览器桥（Playwright），每个账号首次对话需加载页面（约 10~20 秒）；页面就绪后单次对话约 5~15 秒。同一账号串行处理，不同账号并行。
2. 超出 `QWEN_MAX_PAGES` 的账号页会被 LRU 回收，该账号下次请求需重新加载页面。
3. AI 绘图接口与对话同理受风控保护，暂未实现。
4. Token 统计为固定占位数字，实际 token 不可统计。
