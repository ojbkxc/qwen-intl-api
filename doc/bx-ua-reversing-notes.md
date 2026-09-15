# chat.qwen.ai bx-ua 风控逆向调研笔记（2026-09-15）

## 结论

**bx-ua 无法通过纯 HTTP 伪造，短期内不可逆向。** 现有 browser-bridge（UI 驱动）方案是当前唯一可行路径。

## 风控链路（已完整摸清）

1. **页面加载**：app (main.js 0.2.91) 调 `window.baxiaCommon.init({appendTo:"header", uabOptions:{location:"sea"}, checkApiPath:[23个受保护API], paramsType:["uab","umid"]})`
2. **SDK 加载**：`https://g.alicdn.com/sd/baxia/2.5.37/baxiaCommon.js`（fetch/XHR/form/jsonp 全量 hook）
3. **FY 引擎**：`https://g.alicdn.com/AWSC/fireyejs/1.234.24/fireyejs.js`（550KB VM 混淆，暴露 `window.__fyModule`）
4. **请求时**：baxia 的 fetch hook 调 `preRequest` → `addNCParamToRequest` → `getUA()` → `__baxia__.postFYModule.getFYToken()` 生成 bx-ua，连同 `getUidToken()`（bx-umidtoken）注入 header

## 关键发现

| 发现 | 证据 |
| --- | --- |
| bx-ua 每次请求都不同（动态生成） | 连续两次对话捕获的 bx-ua 完全不同（1612/1644 字符） |
| bx-umidtoken 会话级稳定 | 两次对话的 umid 相同 |
| **重放 bx-ua 100% 被 punish** | 捕获后纯 HTTP 原样重放（同 URL/同 body/同 header）→ `FAIL_SYS_USER_VALIDATE::RGV587_ERROR` |
| **页内 evaluate 取新 token + 纯 HTTP 也被 punish** | `__fyModule.getFYToken({reqUrl})` 生成新 token 后 Node fetch → punish |
| **页内直接 fetch 也会触发 punish → 页面被导航/关闭** | baxia 检测到非 app 调用路径的 fetch（调用栈证明），evaluate 报 page closed |
| fireyejs 可在 Node VM 中运行但出不了有效 token | `__fyModule` 加载成功、UBInit/init 回调 OK，但 `getUidToken()` 返回空串、`getFYToken` 崩溃——内部依赖真实浏览器行为数据 |

## 为什么不可行

- **fireyejs 是 VM 字节码级混淆**（550KB，自解释状态机 + 字符串表加密），纯逆向成本极高
- **行为证明（attestation）**：bx-ua 绑定了"请求必须由 app 自己的调用栈在正确时机发出"这一事实——页内合成 fetch 都会被识别并 punish，说明 token 内编码了调用上下文
- **行为数据**：fireyejs 收集鼠标/键盘/焦点等行为流（UBInit TraceInterval），Node stub 无法产出有效的 UB 数据（getUBHeader 在 stub 下产出的是乱码短串）
- 对照组：国内版 qianwen.com 的签名是简单的 HMAC-SHA256 + 设备注册，1 天内可逆向；国际站是阿里安全最高等级防护

## 唯一可行优化方向（保留 chromium）

把 UI 驱动改为"复用常驻页 + baxia wrapper 内的 fetch"不可行；但可以：
- 缩短页面复用周期（当前 bridge 已做）
- 转向**国内版 qianwen.com**（qwen-free-api 项目）——那边纯 HTTP 已打通

## 附：风控 SDK 文件清单

- app: `https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.2.91/js/main.js`（1.8MB）
- baxia: `https://g.alicdn.com/sd/baxia/2.5.37/baxiaCommon.js`（37KB，fetch/XHR hook + punish 处理）
- baxia entry: `https://assets.alicdn.com/g/??/AWSC/AWSC/awsc.js,/sd/baxia-entry/baxiaCommon.js`（45KB，AWSC 模块加载器）
- fireye: `https://g.alicdn.com/AWSC/fireyejs/1.234.24/fireyejs.js`（550KB，VM 混淆 token 引擎）
- 受保护 API 列表：`/api/chat/completions`、`/api/v2/chat/completions`、`/api/v2/chats` 等 23 个
