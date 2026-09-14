# Qwen 国际版 Free API 服务

面向 [Qwen 国外版](https://chat.qwen.ai) 的 OpenAI 兼容 API 服务（国内版为通义千问 tongyi.aliyun.com，本项目对应 chat.qwen.ai）。

## 声明

仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！

## 当前状态

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 账号密码登录换 token | ✅ 可用 | `POST /auth/signin` |
| token 存活检测 | ✅ 可用 | `POST /token/check` |
| 对话补全 | ⚠️ 受风控阻塞 | 接口受 qwen.ai 巴夏风控（bx-ua）保护，纯 HTTP 请求命中人机校验，需接入浏览器运行时 |
| AI 绘图 | ❌ 未实现 | 同样受风控保护 |

## 接入准备

使用一个 chat.qwen.ai 的账号（邮箱 + 密码），通过登录接口换取 token：

```
POST /auth/signin
{"email": "you@example.com", "password": "your_password"}
```

响应中的 `token` 即后续对话接口的 `Authorization: Bearer <token>`。

> 登录密码在客户端做 SHA-256 后提交，服务端不存储任何账号信息。

## 本地运行

```shell
npm i
npm run build
npm start
```

默认端口 `8001`（可通过 `configs/dev/service.yml` 或环境变量 `SERVER_PORT` 修改）。

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

header：`Authorization: Bearer [token]`

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

1. 对话接口受 `chat.qwen.ai` 的巴夏风控（Alibaba Security bx-ua / x5sec）保护，纯 HTTP 请求会命中 `FAIL_SYS_USER_VALIDATE` 人机校验并返回空内容。需要内嵌浏览器运行时（Playwright + bx SDK）生成 `bx-ua`、`bx-umidtoken` 等风控头才能稳定调用。
2. 绘图接口与对话接口同理，暂未实现。
3. Token 统计为固定占位数字，实际 token 不可统计。