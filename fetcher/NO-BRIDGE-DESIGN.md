# 干掉 opencli 浏览器桥：风控调研与直连实施方案

状态：调研/设计稿，未改 fetcher 代码。范围是 `web/fetcher/providers.mjs`
里当前走 `opencli browser eval` 的 9 个 provider
（codex / kimi / ollama / commandcode / grok / devin / opencode / xai / openai）
以及 NO_SESSION 的 cursor / manus。

结论先行：**可以去掉桥，但不能一律用 cookie 直连。** 分三类：

- **第一类（低风险，直接改）**：用厂商自己发给程序用的凭据
  （API key / OAuth token，本机 `~/.pi/agent/auth.json`、`~/.codex/auth.json`、
  `~/.grok/auth.json` 里已经有）。这类请求形态和官方 CLI 一致。
- **第二类（中风险，可改但必须加规则）**：没有程序化凭据，只能复用浏览器
  session cookie 打 JSON 接口（ollama 配额页、commandcode、devin、opencode）。
  上游 CodexBar 在 macOS 上就是这么干的，属于已被实践过的路径。
- **第三类（不建议直连，保留桥或直接放弃）**：目标是 SPA/HTML 且被 Cloudflare
  挡着，或需要浏览器里的密码学材料（grok 的 WKE 密钥对）。典型是
  `chatgpt.com/codex/settings/usage` 和 `grok.com` 的 gRPC 路径。

整体封号风险评估：**低–中**。没有找到任何"因为轮询自己账号的用量接口被封号"
的实证案例；已报道的封号诱因是共享/机房 IP + 频繁跳区、账号共享转售、
高 QPS 自动化、虚拟卡/多账号。本项目的负载（每 provider 每 15 分钟 ≤2 个 GET、
本机住宅 IP、自己的账号、只读）和这些诱因都不像。但厂商 ToS 明确禁止
"自动或以编程方式提取服务数据"和"规避限流/保护措施"，所以这是**合同灰区**，
风险集中在 CF 挑战被反复重试、429 硬闯、以及打"只给浏览器用"的接口上。

---

## 一、本地参考：原生 CodexBar 是怎么做的

结论：**原生 CodexBar 本来就没有桥。** 它读本机凭据，用 `URLSession`
直接发 HTTP。桥（opencli）是 web 版后加的。也就是说本方案本质上是把上游
macOS 行为移植到 Linux/node，不是发明新做法。

### 1.1 凭据获取

四种来源：

- 厂商发出的 OAuth token / CLI 登录态 —— Codex `~/.codex/auth.json`、
  Grok `~/.grok/auth.json`；实现见
  `Providers/Codex/CodexOAuth/CodexOAuthCredentials.swift`、
  `Providers/Grok/GrokAuth.swift`。
- 浏览器 cookie 解密（macOS Keychain + Safe Storage） —— Ollama、Devin、
  CommandCode、OpenCode、Cursor、Notion、Perplexity、MiniMax；入口
  `BrowserCookieAccessGate.swift` + `SweetCookieKit`。
- 浏览器 localStorage —— Devin 的 `auth1_session`、Factory、MiniMax；
  `BrowserLocalStorageAPI.swift`、`Providers/Devin/DevinSessionImporter.swift`。
- 应用本地库 / 文件 / 手工配置 —— Cursor.app `state.vscdb`、Kimi
  `~/.kimi-code/credentials/`；`Providers/Cursor/CursorAppAuth.swift`、
  `Providers/Kimi/KimiSettingsReader.swift`；另有
  `DEVIN_BEARER_TOKEN`、`OPENCODE_API_KEY`、`XAI_MANAGEMENT_API_KEY` 等
  环境变量 / 手工粘贴入口。

注意 Codex 的 token 归属边界：CodexBar **只读** `~/.codex/auth.json`，
刷新和写回留给 Codex CLI；native 凭据过期 → 报错并要求 `codex login`，
外部来源（OpenCode）过期 → fail closed。见 `docs/codex-oauth.md` 与
`ProviderFetchPlan.swift` 的 `nativeRefreshRequired` / `readOnlySource` 语义。

### 1.2 请求形态

- UA 分两种，且与凭据类型绑定：
  - **自己的身份** `CodexBar`：用于 OAuth/API-key 路径。例：
    `CodexOAuthUsageFetcher.swift:411`（`User-Agent: CodexBar` 打
    `chatgpt.com/backend-api/wham/usage`）、`GrokWebBillingFetcher.swift:230`、
    `OllamaUsageFetcher.swift:972`（`CodexBar/1.0` 打 api 路径）、
    `ClaudeAdminAPIUsageFetcher.swift:118`（`CodexBar/1.0`）。
  - **Chrome 伪装 UA**：只在复用浏览器 cookie 打网页接口时用。
    `OllamaUsageFetcher.swift:765-768`、`DevinUsageFetcher.swift:10-12`、
    `CommandCodeUsageFetcher.swift:21-22`、`OpenCodeUsageFetcher.swift:79-80`
    全都是同一串
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36`。
  - 官方客户端 UA：`CodexCLIUserAgent.swift` 生成
    `codex_cli_rs/<version> (Mac OS 15.x; arm64)`，`originator = codex_cli_rs`；
    `CodexOpenAIWorkspaceResolver.swift:77` 用 `codex-cli`。
    `docs/codex-oauth.md` 里把 `User-Agent: codex-cli` 写成该接口的正式 header。
  - 反例：`CursorStatusProbe.swift` 完全没设 UA，只有 Cookie +
    `Origin`（CSRF 需要）。说明 Cursor 后端不校验 UA。
- 配套 header 一律补齐、不加多余项：`Accept`、`Accept-Language: en-US,en;q=0.9`、
  `Origin`（站点根）、`Referer`（对应页面 URL）。
  `OpenCodeUsageFetcher.swift:330-341` 是完整样板：
  `Cookie` / `X-Server-Id` / `X-Server-Instance: server-fn:<uuid>` /
  `Origin` / `Referer` / `Accept`。
- 伪装官方客户端的仅限必要处：reset-credits 与 grok CLI-proxy 需要
  `OpenAI-Beta: codex-1` + `originator: Codex Desktop`
  （`CodexOAuthUsageFetcher.swift:521-524`）、`x-xai-token-auth: xai-grok-cli`
  （`GrokCreditsProxyFetcher.swift:27`）。这是接口要求的，不是伪造指纹。
- 传输层：`CodexAuthenticatedHTTPTransport.makeConfiguration()` 用
  **ephemeral session**，显式 `httpCookieStorage = nil`、
  `httpShouldSetCookies = false`、`urlCache = nil`、`redirectGuardedSession`。
  即：不落 cookie、不缓存、跟重定向但受控。

### 1.3 防风控设计（上游实际有的）

| 机制 | 实现 |
| --- | --- |
| 重试次数 | 至多 1 次（`ProviderFetchDelayedRetry.run`）。 |
| 退避上限 | `Retry-After` 被钳到 **10 秒**（`ProviderFetchClassifiedError.maximumRetryAfterSeconds`）。 |
| 错误分类 | 401/403 是终态权限失败，**不触发** CLI 恢复；只对超时/网络错误/5xx 重试（`GrokWebBillingFetcher.shouldRetry`）。 |
| 请求数 | 每个 provider 每轮 1 个主请求，可选 enrichment 各 1 个且带 4 秒预算（spend-controls / remaining_balance）。 |
| 刷新节奏 | Adaptive 2–30 分钟；最短 2 分钟；Low Power / 过热降到 30 分钟（`docs/refresh-loop.md`）。 |
| cookie 冷却 | 浏览器 cookie 读取被拒后，**整个 Chromium 系 6 小时**不再尝试（`BrowserCookieAccessGate.cooldownInterval = 6h`）。 |
| cookie 缓存 | 解出的 cookie header 缓存在 Keychain，复用；只有 401/403 才失效重导。 |
| 并发 | provider 逐个跑，没有跨 provider 并行轰炸。 |

### 1.4 上游自己的边界声明（说明它对直连的克制）

- Devin：`docs/devin.md` —— "Automatic mode reads only the Devin session and
  organization metadata from Chrome localStorage. It does not scan other
  browsers. **CodexBar sends the session token only to `https://app.devin.ai`.**"
- Notion：`docs/notion.md:34` —— "sends it only to `https://app.notion.com`"。
- xAI：`docs/xai.md:53` —— "CodexBar does not read browser cookies, console
  sessions … only takes Bearer keys"。
- ZenMux / ClawRouter / LiteLLM / IBM Bob：同类"只发给 X"声明。
- Codex web 看板：`docs/codex.md` —— 明确标 **opt-in**，理由是"loads
  `chatgpt.com` in a hidden WebView and can materially increase battery or
  network usage"；走 `WKWebView`（真浏览器引擎）而不是裸 HTTP。
- Ollama：`docs/ollama.md` —— "Browser cookie auth: **Required** for Cloud
  Usage quota windows because Ollama does not expose those limits through the
  documented API."
- Grok：`docs/grok.md` —— grok.com 的 gRPC 现在需要浏览器持有的
  **Web Key Exchange (WKE) 密钥对**，cookie-only 会返回 grpc status 16
  `no-credentials`；推荐恢复路径是 `grok login`。

**关键点**：上游对"HTML/SPA 页面 + Cloudflare"的场景（ChatGPT 看板、
Claude web）用的是真 WebView 或本地 CLI，不是 cookie 重放。cookie 重放只用
在**返回 JSON 的接口**上。这就是本方案的分类依据。

---

## 二、外部调研证据

### 2.1 cookie 直连 ChatGPT 的封号风险

- 没有找到"用 cookie 轮询 `chatgpt.com/backend-api/wham/usage` 被封号"的案例。
- **存在成熟商业/开源先例**：菜单栏应用 tokn.watch 就是读 chatgpt.com 的
  cookie、默认**每 5 分钟**轮询内部限额接口，且把它作为官方缺失功能的替代
  （<https://tokn.watch/blog/chatgpt-usage-tracker/>）。同一篇文章也点出反面：
  Pro 档"unlimited"受一条不公开的 fair-use clamp 约束，**触发条件是
  "sustained 24/7 calling, parallel scripted requests, content-farm patterns"**。
- 中文实践文章记录了一模一样的做法（Chrome cookie DB → macOS `security`
  取 Safe Storage → PBKDF2-SHA1(`saltysalt`,1003) → AES-CBC 解 `v10`，
  并先把 DB 复制到临时目录避免抢锁），目标就是 `chatgpt.com` 的
  `wham/usage`：<https://www.cnblogs.com/nsys/p/19878903>。
- **官方 CLI 自己每 ~60 秒轮询同一个接口**：
  <https://github.com/openai/codex/issues/10869>（`ChatWidget::prefetch_rate_limits`
  → `backend-api/wham/usage`）。我们 15 分钟一次，远低于正常水位。
- **真实封号诱因（社区/第三方汇总，非官方政策）**：共享或机房 IP、频繁跳区、
  虚拟卡/频繁换支付方式、账号共享转售、单账号跑高强度自动化。
  <https://qcode.cc/en/codex-account-ban-guide>、
  <https://finance.sina.cn/2026-06-05/detail-iniakfhp1594524.d.html>。
- **用户社区已经在担心"用量查询本身"的风险**：
  <https://github.com/farion1231/cc-switch/issues/3519> —— 要求提供"关闭订阅
  用量查询"开关，理由是"openai 的风控策略都和访问时的 ip 有关…严重会触发封号"。
  这是**担忧**而非已证实的封号案例，但方向明确：**IP 一致性 > 请求本身**。
- **ToS 原文（重要）**：<https://openai.com/policies/terms-of-use/> 禁止行为里
  明确列出（中文官方版）：
  - "自动或以编程方式提取我们服务中的数据或输出内容"
  - "干扰或破坏我们的服务，包括规避任何速率限制或其他限制条件，或绕过我们
    为服务设置的任何保护措施或安全防护机制"
  - "您不得分享您的帐户凭据"

  解读：读自己的额度数字不算"提取 Output"，但**反复重试被限流/被挑战的
  请求就正好命中第二条**。这决定了下面"什么时候必须停"的规则。

### 2.2 Cloudflare 与指纹约束

- `cf_clearance` 与**生成它的 TLS 指纹、IP、User-Agent** 绑定；换了其中任何一个
  就会重新被 challenge（<https://stackoverflow.com/questions/75857794/>、
  <https://www.scrapeless.com/en/blog/cf-clearance>）。
- Cloudflare 现行是持续会话评估 + JS detection，不是"过一次就永久通行"
  （<https://developers.cloudflare.com/cloudflare-challenges/precursor/>）。
- 直接后果：**node `fetch`（undici）的 TLS 指纹 ≠ Chrome**，所以任何 CF 挡着的
  HTML/SPA 页面，即使 cookie 完全正确也会被 challenge。想在 node 里"过 CF"
  就是在绕过保护措施 —— 既是 ToS 红线，工程上也是必输。
- **官方客户端也会吃 CF 403**：
  <https://github.com/openai/codex/issues/21346>（Codex CLI
  `connectors/directory/list` 被 CF 挑战）、
  <https://github.com/openai/codex/issues/16341>（VS Code Codex 扩展收到 CF
  挑战 HTML 导致鉴权失败）。说明 CF 挡的是**特定 endpoint**，不是账号。
- 用量接口会被限流但不封号：Anthropic `/api/oauth/usage` 对 Max 用户持续
  429：<https://github.com/anthropics/claude-code/issues/30930>。

### 2.3 "直连"在同类工具里是不是常态

是。多个第三方工具都在做同样的事，没有一例报告封号：

- Ollama Cloud 配额抓取（Python，单文件，cookie scraper + API fallback）：
  <https://github.com/Kosello/ollama-cloud-watch>
- opencode-quota 的 Ollama Cloud provider（cookie-based quota scraping）：
  <https://github.com/slkiser/opencode-quota/pull/103>
- `usage-monitor-cli` 的 Rust 实现直接注明 "Ports CodexBar's scrape of the
  settings page"：<https://docs.rs/usage-monitor-cli/latest/src/usage_monitor_cli/provider/ollama.rs.html>
- 大量 Claude 配额监控工具（ccusage 系、claude-rate-monitor、
  claude-code-statusline），全部读本机令牌打官方额度接口：
  <https://juejin.cn/post/7625981684123009074>

### 2.4 grok / devin / commandcode / opencode 的具体障碍

- **grok**：`GetGrokCreditsConfig` 现在要求 WKE 密钥对，cookie-only 报
  `grpc-status 16 No credentials presented [WKE=unauthenticated:no-credentials]`：
  <https://github.com/steipete/CodexBar/issues/2812>（与本地 `docs/grok.md` 一致）。
  → 裸 HTTP 打不通；要么用 `~/.grok/auth.json` 的 CLI token 走
  `cli-chat-proxy.grok.com`，要么保留桥。
- **devin / commandcode / opencode**：没有找到针对性的封号/封禁报道，但也没有
  官方 API 承诺。它们和 Ollama 一样属于"厂商只给浏览器用的内部接口"。
  上游 CodexBar 的做法（单次 GET + Chrome UA + Origin/Referer + cookie 缓存）
  是目前可见的最低风险形态。

---

## 三、风险结论

### 3.1 整体评级

| 维度 | 判断 |
| --- | --- |
| 账号封禁（永久） | **低**。无实证案例；负载特征与已知诱因不符。 |
| 临时限流 / 403 / CF 挑战 | **中**。尤其 opencode.ai、grok.com、ollama.com 这类 CF 站点。 |
| ToS 违约（合同层面） | **存在**。OpenAI ToS 明禁"自动提取"与"规避限流"。 |
| 凭据泄露 | **低**，前提是沿用上游规则：只读、不刷新、不写回、不落盘 cookie。 |

### 3.2 分 provider 评级

| Provider | 评级 | 直连手段 |
| --- | --- | --- |
| `openai` | 低（≈无） | org Admin API key（已是直连） |
| `xai` | 低（≈无） | Management API key（已是直连） |
| `kimi` | 低 | `api.kimi.com` + `sk-kimi-` key（已是直连） |
| `codex` | 低–中 | 本地 OAuth token + `wham/usage` |
| `devin` | 低–中 | 本机 `auth.json` 的 `devin-session-*` |
| `grok` | 低–中 | `~/.grok/auth.json` 的 CLI token |
| `ollama` | 中 | cookie + HTML 配额页 |
| `opencode` | 中 | auth.json key，或 cookie + server-fn |
| `commandcode` | 中 | better-auth cookie（key 待验证） |
| `cursor` | 中 | 本地 app token（`state.vscdb`） |
| `manus` | 高 | 无 session、无已知 API |

依据补充：

- `openai` / `xai`：厂商为程序化使用设计的 key，现在就是直连。
- `kimi`：官方 CLI 用同一凭据，已实现。
- `codex`：`wham/usage` 是官方 CLI 每 60s 打的接口；"中"只出现在
  cookie 回退路径。
- `devin`：上游 CodexBar 已用同一 token 单次 GET `app.devin.ai`。
- `grok`：`x-xai-token-auth: xai-grok-cli` 是官方 CLI 通道；
  **cookie gRPC 路径 = 高（WKE 不可得），不要走**。
- `ollama`：API key 不提供配额，配额只在 `ollama.com/settings` 的 HTML 里。
- `opencode`：`_server` 是 SolidStart server function，需要
  `X-Server-Id` + `X-Server-Instance` + Origin/Referer；有 `OPENCODE_API_KEY`
  时可降到低。
- `commandcode`：打的是 `api.commandcode.ai/internal/*`，"internal" 命名本身
  就是信号。
- `cursor`：本来就没有 session；有本地 app token 可用，优先级低于上面几个。

### 3.3 一句话选型

优先用**厂商发给程序用的凭据**；其次用**返回 JSON 的 cookie 接口**；
**绝不用裸 HTTP 打 CF 挡着的 HTML/SPA，也不尝试合成或复用 `cf_clearance`**。

---

## 四、防风控实施规则（可执行）

### 4.1 User-Agent

规则：**UA 必须和凭据类型一致**，并且反映本机真实环境。

1. 浏览器 session 类（ollama 配额页 / devin / commandcode / opencode / cursor）：

   ```text
   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<本机主版本>.0.0.0 Safari/537.36
   ```

   `<本机主版本>` 从本机 Chrome 实际版本读（`google-chrome --version`
   或 profile 的 `Local State` / `Last Version`），**不要写死一个假版本**。
   上游写死 `Chrome/143` 是因为它按 macOS 打包发布；我们这个 fetcher 跑在
   Linux，写错平台反而制造不一致。
2. 官方 CLI 凭据类（codex / grok / kimi）：

   - codex：`codex_cli_rs/<本机 codex --version> (Linux <kernel>; x86_64)` +
     `originator: codex_cli_rs`（照 `CodexCLIUserAgent.swift` 的格式）。
     取不到版本就退回 `CodexBar/1.0`。
   - grok：`CodexBar/1.0`（上游用的就是自己的身份）。
   - kimi：已有的 `Authorization: Bearer` 路径不变（api 侧不校验 UA）。
3. 纯 API key 类（xai / openai）：`CodexBar/1.0`。**不要**给 API key 请求套
   Chrome UA —— 那才是异常组合。

禁止：`headless`、`Electron`、`node-fetch`、`axios/*`、空 UA、`Python-urllib`。

### 4.2 Header

每个请求**照抄上游那一套**，多一个不加、少一个不落：

```text
Cookie: <provider-scoped cookie header>
Accept: application/json, text/plain, */*
Accept-Language: en-US,en;q=0.9
Origin: https://<站点根>
Referer: https://<站点根>/<触发该请求的真实页面路径>
```

- HTML 页面（ollama settings）：`Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`。
- opencode：额外带 `X-Server-Id`（固定常量）与
  `X-Server-Instance: server-fn:<randomUUID>`；参考
  `OpenCodeUsageFetcher.swift:330-341`。
- 传输层照上游：**不落 cookie**（`httpShouldSetCookies=false`）、不缓存、
  不跟随跨域重定向 —— node 侧用 `redirect: "manual"` 或只允许同站跳转。
- Referer 必须指向"浏览器真会停在那里的页面"，不要用假的深链。

### 4.3 节奏 / 并发 / 预算

| 参数 | 取值 | 理由 |
| --- | --- | --- |
| 单 provider 最小间隔 | **15 分钟**（保持现在 `REFRESH_MINUTES=15`） | 官方 CLI 自己 60s；15 分钟已是保守值。 |
| 抖动 | 每个 provider 加 `±20%` 抖动 | 精确整点的固定间隔是已记录的机器人特征。 |
| 并发 | **逐 provider 串行**，同一 provider 最多 1 个在途请求；全局在途 ≤1 | `fetchAll` 现有串行循环保持不动，不要 `Promise.all`。 |
| 单轮请求数 | 每 provider ≤2（1 主 + 1 可选 enrichment）；硬上限 3 | 对齐上游。enrichment 给 4 秒预算，超时就丢。 |
| 超时 | 连接+响应 15 秒（HTML 20 秒） | 上游同量级。 |
| 请求间最小间隔 | 同一 provider 的两个请求之间 ≥500ms | 避免"零间隔连打"的明显脚本特征。 |

### 4.4 失败与停止（这是最关键的一条）

| 响应 | 动作 |
| --- | --- |
| 401 | 停止该 provider，标 `no-session`，**不重试**。 |
| 403 | 同上，**不重试**。403 常见于 CF/权限拒绝，重试只会加深"规避保护"的证据。 |
| 429 | 尊重 `Retry-After`，但**钳到 ≤10 秒**；只重试 1 次；仍失败 → 进入冷却。 |
| 408 / 5xx / 网络超时 | 退避 2s→5s（带抖动）重试 **1 次**，再失败就跳过本轮。 |
| CF 挑战 | 判定：`cf-mitigated` header、响应体含 `<title>Just a moment`、
  期望 JSON 却收到 `text/html`、含 `cf-chl-`/`__cf_chl` 痕迹。
  → **立即放弃该 provider，绝不尝试解开**，进入冷却。 |
| 连续 2 次 403/429/CF 挑战 | 该 provider **冷却 6 小时**（照上游
  `BrowserCookieAccessGate.cooldownInterval = 6h`），界面显示"已暂停，需手动恢复"。 |

明确不做：指数退避多轮、换 UA 重试、换 IP 重试、绕过 CF、解 challenge。
**"硬闯"是这里唯一真正会升级风险的行为。**

### 4.5 凭据与指纹一致性

- cookie **解一次、缓存复用**（内存 + 落盘 0600），只在 401/403 时失效重解；
  不要每个周期重读浏览器 cookie 库。
- 读 Chrome cookie DB 前先 `cp` 到临时目录再以只读打开，避免和 Chrome 抢锁。
- **不刷新、不写回**别的应用的 token（沿用 `docs/codex-oauth.md` 的所有权规则）。
  过期就报 `no-session`，让用户去 `codex login` / `grok login` / 重新登录。
- **IP/出口一致**：不要走代理/VPN/轮换出口。cc-switch 那条 issue 的核心关切
  就是"跳区"。node 侧显式不读 `HTTP_PROXY` 之外的任何代理配置，并保持和
  浏览器同一出口。
- **不要与真实浏览器并发**：同一个 provider 既然改成 HTTP 抓，就**移除它的
  `cli(["open", url])` 导航**（现在 `evalInPage` 每个 provider 都会开一个 tab
  并 `sleep(1500)`）。桥和直连不要同时打同一个站点。
- 日志：只记状态码 + 用了哪条凭据路径（`oauth` / `cookie` / `apikey`），
  **绝不打印 token / cookie 值**。

---

## 五、分 provider 技术方案表

凭据列优先序 = 实现优先序。

凭据列的行内优先序 = 实现优先序。

### `codex`

- 凭据：① `~/.pi/agent/auth.json` 的 `openai-codex.{access,accountId}`；
  ② `~/.codex/auth.json` 的 `tokens.{access_token,account_id}`（CLI 所有，
  可能过期）；③ cookie（最后手段）
- Endpoint：`GET https://chatgpt.com/backend-api/wham/usage`；可选
  `GET .../wham/rate-limit-reset-credits`、
  `GET .../accounts/<id>/spend-controls/current-user/monthly-usage`、
  `GET .../accounts/<id>/remaining_balance`
- 形态：GET JSON，`Bearer` + `ChatGPT-Account-Id`
- 难点：native 凭据过期 → 报错让用户跑 `codex login`，**不要自己刷新**；
  reset-credits 需要 `OpenAI-Beta: codex-1` + `originator`

### `kimi`

- 凭据：`~/.pi/agent/auth.json` 的 `kimi-coding.key`（已有）
- Endpoint：`GET api.kimi.com/coding/v1/usages`、
  `GET agent-gw.kimi.com/coding/v1/usages`
- 形态：GET JSON Bearer
- 难点：无（已实现，可删除 web 回退）

### `ollama`

- 凭据：① `OLLAMA_API_KEY` / `auth.json` 的 `ollama-cloud.key`（仅 api 路径，
  无配额）② Chrome cookie（配额必需）
- Endpoint：api 侧 `POST ollama.com/api/web_search`（校验）、`GET /api/tags`；
  配额侧 `GET https://ollama.com/settings`
- 形态：GET HTML + 正则解析
- 难点：配额只在 HTML 里；Linux Chrome cookie 解密（`v10/v11`，无 keyring 时走
  `peanuts` 派生）；上游 `OllamaUsageParser` 要在 node 重写；CF 风险需实测

### `commandcode`

- 凭据：① `auth.json` 的 `commandcode.key`（`user_...`，**待验证**是否被
  billing 接口接受）② `commandcode.ai` better-auth cookie
- Endpoint：`GET api.commandcode.ai/internal/billing/credits`、
  `GET /internal/billing/subscriptions`
- 形态：GET JSON，必须带 `Origin` / `Referer`
- 难点：plan→月额度映射表要维护；`/internal/` 路径稳定性差

### `grok`

- 凭据：`~/.grok/auth.json`（`key` + `refresh_token`，`GROK_HOME` 可覆盖）或
  `GROK_OAUTH_TOKEN`
- Endpoint：`GET cli-chat-proxy.grok.com/v1/billing?format=credits`、
  `GET /v1/settings`
- 形态：GET JSON，`Bearer` + `x-xai-token-auth: xai-grok-cli`
- 难点：token ~7 天过期，刷新归 `grok` CLI；**不要**走 grok.com gRPC

### `devin`

- 凭据：① `~/.pi/agent/auth.json` 的 `devin.access`（`devin-session-...`）
  ② Chrome localStorage 的 `*auth1_session`
- Endpoint：`GET app.devin.ai/api/<internal-org-id>/billing/quota/usage`
  （回退 `org/<slug>`、裸 slug、`organizations/<id>`）
- 形态：GET JSON，`Bearer` + `x-cog-org-id`
- 难点：internal org id 本机 auth.json 里没有，需要在 Usage 页抓一次；
  `No organizations found for auth1 user` 要单独识别

### `opencode`

- 凭据：① `OPENCODE_API_KEY` / `auth.json` 的 `opencode-go.key` →
  `opencode.ai/zen/go/v1/usage` ② `opencode.ai` cookie + workspace id
- Endpoint：② `POST https://opencode.ai/_server?id=<workspaces|billing>`
- 形态：① GET JSON ② 服务函数 POST
- 难点：两个 server-fn 常量 ID 会随前端构建变化；workspace id 要先发现；
  返回 `text/javascript`，要宽松解析

### `xai`

- 凭据：`XAI_MANAGEMENT_API_KEY` + `XAI_TEAM_ID`
- Endpoint：`GET management-api.x.ai/v1/billing/teams/<t>/prepaid/balance`、
  `POST /usage`
- 形态：GET / POST JSON
- 难点：无（已直连）；余额 `total.val` 是取负的字符串

### `openai`

- 凭据：`OPENAI_ADMIN_KEY` / `OPENAI_API_KEY`（+ `OPENAI_PROJECT_ID`）
- Endpoint：`GET api.openai.com/v1/organization/costs`；回退
  `/v1/dashboard/billing/credit_grants`
- 形态：GET JSON
- 难点：无（已直连）

### `cursor`

- 凭据：Cursor.app `state.vscdb` 的 `cursorAuth/accessToken`，或 cookie
  （`WorkosCursorSessionToken` 等）
- Endpoint：`GET cursor.com/api/usage-summary`、`/api/auth/me`、
  `POST /api/dashboard/get-sand-usage-status`
- 形态：GET / POST JSON
- 难点：POST 需要匹配的 `Origin`（CSRF）；本地 app token 优先，可完全避开 cookie

---

## 六、明确"不建议直连、保留桥"的清单

1. **`chatgpt.com/codex/settings/usage`（OpenAI web extras：code review 剩余、
   用量明细、credits 历史）** —— SPA + Cloudflare + 客户端 hydration，
   上游为此专门维护 `WKWebView`（`docs/codex.md` 标 opt-in）。裸 HTTP 抓不到，
   硬解 CF 就是"绕过保护措施"。**保留桥**（现状本来就只读 `wham/usage` 那部分，
   extras 可以不要）。
2. **`grok.com` 的 gRPC-web billing 回退（cookie 路径）** —— 需要浏览器持有的
   WKE 密钥对，裸 HTTP 必得 `grpc-status 16 no-credentials`
   （<https://github.com/steipete/CodexBar/issues/2812>）。
   **改成只走 `~/.grok/auth.json`；cookie 路径要么保留桥，要么删掉。**
3. **任何被 Cloudflare 挡的 HTML 页面**（含 `ollama.com/settings` 若实测吃挑战、
   `opencode.ai` 的 HTML 视图） —— 判定标准就是上面 4.4 的 CF 检测。
   node 客户端没有 Chrome 的 TLS/JS 指纹，**不要尝试合成或复用
   `cf_clearance`**（它与 TLS/IP/UA 绑定，复用必然进 re-challenge loop，
   且明确落在 ToS 的"规避保护措施"里）。
4. **`manus`** —— 无 session、无已知接口，维持 `NO_SESSION_PROVIDERS`。
5. **任何需要"多账号共享一个浏览器会话"的场景** —— ToS 明确禁止分享凭据，
   且多账号是已报道的封号诱因。

---

## 七、实施顺序建议（给下游小弟/实施阶段）

1. **第一步（零风险，先摘桃子）**：把 `xai` / `openai` / `kimi` 从桥里摘出来
   （已经是纯 HTTP，只需去掉 `evalInPage` 包装）；再加 `codex` 走
   `~/.pi/agent/auth.json → openai-codex` OAuth token。这一步就能砍掉 4/9 的
   桥流量，且风险评级低。
2. **第二步（中风险，逐条验证）**：`devin`（auth.json 有 token）→ `grok`
   （`~/.grok/auth.json`）→ `opencode`（先试 `OPENCODE_API_KEY`）→
   `commandcode`。每加一条先跑通"单次手动请求"，再进循环。
3. **第三步（最后、可选）**：`ollama` 配额 HTML 抓取。它在 Linux 上需要
   Chrome cookie 解密 + HTML 解析两件重活，且 CF 未知，收益最小。
4. **始终**：先落地第四节的规则模块（UA/header/节奏/停止条件/冷却），
   再逐个接 provider —— 不要先接通再补规则。

---

## 附：证据链接

本地代码：

- `Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift`
- `Sources/CodexBarCore/Providers/Codex/CodexPAT/CodexCLIUserAgent.swift`
- `Sources/CodexBarCore/OpenAIWeb/OpenAIDashboardFetcher.swift`（`dashboardUsageAPIRequest`）
- `Sources/CodexBarCore/OpenAIWeb/OpenAIDashboardFetcher+SessionAuthorization.swift`
- `Sources/CodexBarCore/Providers/Ollama/OllamaUsageFetcher.swift`
- `Sources/CodexBarCore/Providers/Devin/DevinUsageFetcher.swift`
- `Sources/CodexBarCore/Providers/CommandCode/CommandCodeUsageFetcher.swift`
- `Sources/CodexBarCore/Providers/OpenCode/OpenCodeUsageFetcher.swift`
- `Sources/CodexBarCore/Providers/Grok/GrokWebBillingFetcher.swift`、`GrokCreditsProxyFetcher.swift`
- `Sources/CodexBarCore/Providers/Kimi/KimiUsageFetcher.swift`
- `Sources/CodexBarCore/Providers/ProviderFetchPlan.swift`（重试/`Retry-After` 上限）
- `Sources/CodexBarCore/BrowserCookieAccessGate.swift`（6h 冷却）
- `Sources/CodexBarCore/CodexAuthenticatedHTTPTransport.swift`（ephemeral、无 cookie 存储）
- `docs/codex.md`、`docs/codex-oauth.md`、`docs/ollama.md`、`docs/devin.md`、
  `docs/command-code.md`、`docs/opencode.md`、`docs/grok.md`、`docs/cursor.md`、
  `docs/refresh-loop.md`

外部：

- OpenAI ToS（禁止自动提取 / 规避限流）<https://openai.com/policies/terms-of-use/>
- Codex CLI 每 60s 轮询 `wham/usage` <https://github.com/openai/codex/issues/10869>
- tokn.watch：cookie + 5 分钟轮询 chatgpt.com，及 Pro fair-use clamp 描述
  <https://tokn.watch/blog/chatgpt-usage-tracker/>
- 中文实践：Chrome cookie 解密流程 + chatgpt wham/usage
  <https://www.cnblogs.com/nsys/p/19878903>
- 封号诱因汇总 <https://qcode.cc/en/codex-account-ban-guide>
- 封号讨论（2026-06）<https://finance.sina.cn/2026-06-05/detail-iniakfhp1594524.d.html>
- 用量查询开关诉求（cc-switch #3519）
  <https://github.com/farion1231/cc-switch/issues/3519>
- cf_clearance 与 TLS/IP/UA 绑定
  <https://stackoverflow.com/questions/75857794/>、
  <https://www.scrapeless.com/en/blog/cf-clearance>
- Cloudflare Precursor（持续会话评估）
  <https://developers.cloudflare.com/cloudflare-challenges/precursor/>
- 官方客户端也吃 CF 403
  <https://github.com/openai/codex/issues/21346>、
  <https://github.com/openai/codex/issues/16341>
- Grok WKE 拒绝 <https://github.com/steipete/CodexBar/issues/2812>
- 用量接口限流不封号 <https://github.com/anthropics/claude-code/issues/30930>
- 同类工具先例 <https://github.com/Kosello/ollama-cloud-watch>、
  <https://github.com/slkiser/opencode-quota/pull/103>、
  <https://juejin.cn/post/7625981684123009074>
