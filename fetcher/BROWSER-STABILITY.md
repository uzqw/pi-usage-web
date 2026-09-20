# 浏览器桥稳定性调研：CF 挑战、Playwright、opencli 改进

状态：调研稿，未改 fetcher 代码。配套文档：`NO-BRIDGE-DESIGN.md`
（直连方案与风控评估）。本文只回答一个问题：**抓取链里"浏览器"这一环
怎么做到稳定**，以及 codex 到底还需不需要浏览器。

实测日期：2026-09-20。

---

## 0. 结论先行

**Codex 不需要浏览器。** 已实测：

```
POST https://auth.openai.com/oauth/token   → 200（refresh_token 换到新 access_token）
GET  https://chatgpt.com/backend-api/wham/usage
     Authorization: Bearer <新 access_token>
     ChatGPT-Account-Id: <account_id>
     User-Agent: codex-cli                  → 200，返回完整 rate_limit JSON
```

也就是说 codex 的最优路径是 **纯 HTTP + `~/.codex/auth.json`**，和原生
CodexBar macOS 版完全一致（`CodexOAuthUsageFetcher.swift`）。浏览器桥
对 codex 的唯一作用是拿 `/api/auth/session` 的 accessToken——而那个
accessToken 就是 auth.json 里 OAuth token 的同一个东西，CLI 登录时
已经发到本机了。

被 CF managed challenge 拦的只有 `chatgpt.com/api/auth/session`
（HTML/session 端点，实测 403 + `cf-mitigated: challenge`）。
`backend-api/wham/usage` 和 `auth.openai.com/oauth/token` **都不走
JS challenge**：前者裸 curl 返回 401（要 token 但不要浏览器），后者
直接 200。CF 拦的是"浏览器会话端点"，不是"API 端点"。

**推荐方案排序**：

| 排序 | 方案 | 适用面 | 结论 |
| --- | --- | --- | --- |
| **A** | **auth.json OAuth token 直连**（codex 专用） | codex | 立即消除 codex 对桥的依赖；最稳定 |
| **B** | **opencli 复用 tab + 健康检查**（保留桥时） | 仍需桥的 provider | 成本最低的中期改进 |
| **C** | Playwright attach 到运行中的 Chrome（CDP） | 桥彻底不可救时 | 备选，不是首选 |
| **D** | curl-impersonate / curl_cffi 伪装 TLS | 仅非 JS-challenge 端点 | 对 codex 无用，对 CF HTML 页不够 |
| **E** | cf_clearance cookie 导出复用 | — | 不要做（短命 + 绑定 TLS/UA/IP） |

---

## 1. Codex 最佳路径：auth.json 直连（方案 A）

### 1.1 事实

本机 `~/.codex/auth.json` 存在，`auth_mode: "chatgpt"`，含完整
`id_token` / `access_token` / `refresh_token` / `account_id`。
`last_refresh: 2026-07-17`。

- access_token JWT `exp = 2026-07-27` —— **已过期**（小弟说的没错）。
- **但 refresh_token 仍然有效**：实测 `POST auth.openai.com/oauth/token`
  用当前 refresh_token 换到了新 access_token（exp 2026-09-30，约 10 天）
  和新 refresh_token。
- 用新 access_token 打 `wham/usage` 返回 200 完整数据（plan plus、
  primary/secondary window、additional_rate_limits 全在）。

### 1.2 与原生 CodexBar 的一致性

`docs/codex-oauth.md` 规定的所有权边界：**读 auth.json 可以，刷新和
写回归 Codex CLI**。web fetcher 是纯 node 脚本、没有 Codex CLI 的所有权
问题，但同一个边界仍然是最稳的做法：

- **首选**：读 auth.json → access_token 没过期就直接打 wham/usage。
- **过期时**：fetcher 自己拿 refresh_token 调 `oauth/token` 换一个
  （端点不被 CF 拦，已实测）。换到的新 token **写回 auth.json** 还是
  只留在内存，是个策略选择：
  - 写回 = 和 CLI 共享同一个 refresh token，有"refresh token 轮换后
    另一边失效"的经典竞态。原生版因此明确不碰。
  - 不写回 = fetcher 自己持有 refresh_token 副本；refresh_token 轮换
    后副本失效，下次再读 auth.json（CLI 可能已经刷新过）。**推荐这个**：
    把 auth.json 当只读源，refresh 只在内存里做，失败就报
    `codex login`。
- **彻底失效时**（refresh_token revoked/expired）：提示用户跑
  `codex login`。本机没有 `codex` 在 PATH（只有别的项目 node_modules
  里的 vendor 二进制），所以 fetcher 不能依赖"调 CLI 刷新"。

### 1.3 收益

- codex 从"5 跳桥 + 每次开 tab + eval fetch"变成"读文件 + 1 个 HTTPS
  GET"。HTTP -1 这类桥错误对 codex 直接消失。
- wham/usage 是官方 CLI 每 60 秒自己打的接口
  （`codex-rs` `ChatWidget::prefetch_rate_limits`），15 分钟一次远低于
  正常水位，风控角度比"浏览器里 eval fetch"更干净——后者才是
  不寻常形态。

---

## 2. CF managed challenge 到底检测什么

综合 2025–2026 的公开资料（BrowserStack、Apify、DEV、多个指纹服务商
teardown），CF 的分层是：

| 层 | 检测内容 | 对 node 直连的影响 |
| --- | --- | --- |
| 网络信誉 | IP ASN、数据中心 vs 住宅、历史请求速率 | 本机住宅 IP，不是瓶颈 |
| **TLS/JA3/JA4** | ClientHello 的 cipher/extension/ALPN 排序 | **node 必死**：undici 指纹 ≠ Chrome |
| HTTP/2 指纹 | SETTINGS 帧、pseudo-header 顺序 | 同上 |
| JS challenge | 执行 JS、收集 canvas/WebGL/audio/navigator | 只有真浏览器能过 |
| 行为 | 鼠标、时序、请求模式 | 低频 GET 基本不触发 |

关键点（多来源一致）：

- `cf_clearance` **绑定 IP + User-Agent + TLS 指纹**，有效期常见
  30–120 分钟（站点可配）。换任何一个因素立即作废。从浏览器导出给
  node 用 = TLS 指纹不匹配 = 作废。**方案 E 排除**。
- `playwright-stealth` / `puppeteer-extra-stealth` 在 2026 年对
  **managed challenge / Turnstile 基本失效**：它只 patch
  `navigator.webdriver` 等 JS 层属性，改不了 TLS 指纹（Playwright 自带
  Chromium 的 JA4 和真 Chrome 不一致）、改不了 IP、改不了 canvas/WebGL
  硬件指纹。多个来源（humanbrowser.cloud 实测、cloudflare-bypass-2026
  README、Apify）都明确把它列为"不建议作为主路径"。
- **能过 managed challenge 的开源基线**（cloudflare-bypass-2026 的
  推荐）：**有头真 Chrome + 可选住宅 IP + CDP/UC 控制 + 必要时 OS 级
  点击**。注意是"真 Chrome"，不是 Playwright 下载的 Chromium。
- `curl_cffi` / `curl-impersonate` 能过 **TLS 指纹层**（JA3/JA4 伪装成
  Chrome，实测 block rate 从 ~100% 降到 ~7%），但**过不了 JS
  challenge**——它没有 JS 引擎。对 `api/auth/session` 这种明确回了
  `cf-mitigated: challenge` 的端点没用。**方案 D 对 codex 无用**。
- Node 侧的 TLS 伪装（wreq-js、nlcurl、lemon-tls、curl-cffi-node）
  都是 2026 年新出现的小包，成熟度低，周下载量百级。不值得押注。

**对 codex 的直接含义**：需要过 challenge 的只有 `/api/auth/session`，
而它给的 accessToken 和 auth.json 里的是同一个 OAuth token。绕开
session 端点 = 绕开整个 CF 问题。方案 A 成立的根本原因就在这里。

---

## 3. Playwright 方案评估（方案 C）

### 3.1 能不能过 CF

- Playwright 自带 Chromium：JA4 指纹和真 Chrome 有差异，2026 年的 CF
  能识别。配 stealth plugin 也救不了 TLS 层。
- **`channel: "chrome"` 启动系统 Chrome**：可以，指纹就是真 Chrome 151。
  这是 Playwright 过 CF 的唯一现实路径。
- **persistent context 复用 `~/.config/google-chrome`**：技术上
  `launchPersistentContext("~/.config/google-chrome", { channel: "chrome" })`
  可行，但**不能和正在运行的 Chrome 同时用同一个 profile**（profile
  锁）。要复用登录态要么 (a) 关掉日常 Chrome 再用 Playwright 独占启动，
  (b) 复制一份 profile（cookie 解密依赖本机 keyring，复制后可用），
  (c) CDP attach。
- **CDP attach 到已运行 Chrome**：`chromium.connectOverCDP(
  "http://localhost:9222")`，前提是 Chrome 启动时带
  `--remote-debugging-port=9222`。本机当前 Chrome 没带这个参数
  （`ss -tlnp` 无 9222），要重启 Chrome 加 flag——这对"用户日常浏览器"
  是个侵入性改动。DEV 上有实测文章（2026-09）说 attach 到自己启动的
  Chrome 能直接走过 CF block，是真 Chrome 指纹的又一佐证。
- **headless**：headless Chrome 的指纹（`HeadlessChrome` UA、缺 GPU
  渲染特征）更容易被识别。要过 challenge 得 headed。本机 `DISPLAY=:1`
  有真实桌面、Chrome 正在跑，headed 可行；`xvfb-run` 也在，可做兜底。

### 3.2 对比 opencli

| 维度 | opencli 桥 | Playwright |
| --- | --- | --- |
| 链路 | node → daemon → WS → 扩展 → CDP → tab eval（5 跳） | node → CDP → Chrome（2 跳） |
| 维护方 | 自研 | 官方，API 稳定 |
| 等网络/等导航 | 手动 sleep | `waitForResponse` / `waitForLoadState` 内建 |
| 复用登录态 | 天然（就是用户 Chrome） | 需 CDP attach 或复制 profile |
| 干扰用户 | 每次 open 抢 tab/导航 | attach 模式下可以只读已有 tab |
| 依赖 | 已装 | 需 `npm i playwright` + 浏览器（可用系统 Chrome，免下载） |

稳定性上 Playwright **确实更好**（少 3 跳、官方维护、有正经的等待原语），
但**对 codex 是杀鸡用牛刀**——codex 根本不需要浏览器。Playwright 的
合理定位是：**如果将来某个 provider 的接口只有浏览器能拿（比如 grok
的 WKE、或某个必须在页面上下文里签名的接口），而且 opencli 桥修不好，
再上 Playwright + CDP attach**。现在不必引入。

### 3.3 本机环境检查（如果要用）

- playwright npm 包：**未安装**（`import("playwright")` 失败）。
- `~/.cache/ms-playwright` 有 chromium-1217/1228 缓存（别的项目留下的），
  但用 `channel: "chrome"` 打系统 Chrome 不需要它。
- 系统 Chrome：`/opt/google/chrome/chrome`（google-chrome-stable），
  正在运行（wayland）。
- `DISPLAY=:1`，`Xvfb`/`xvfb-run` 已装。headed 和 xvfb 兜底都可行。
- CDP attach 需要重启 Chrome 加 `--remote-debugging-port`（侵入性，
  会影响用户日常浏览器）。

---

## 4. opencli 桥稳定性改进（方案 B）

如果保留桥（ollama HTML 页、devin localStorage 类接口短期内仍需），
现状问题和可改进点：

### 4.1 现状问题定位

链路：`fetch.mjs` → `opencli browser <session> open <url>` → daemon
(19825) → WS → Chrome 扩展 → CDP → tab 内 eval fetch。

- **HTTP -1 的来源**：`evalInPage` 里 in-page fetch reject（页面还在
  settle、网络抖动、或 tab 正在导航中）。providers.mjs 已有一层
  "status<0 就重 eval"，fetch.mjs 又有一层"整 provider 重试"。
- **每次 open 新 tab / 重新导航**：`open <url>` 每次都 `page.goto`，
  导航中的 tab 上 eval 就是 -1 的高发区。
- **opencli 已有但没用上的机制**：
  - `browser <session> tab list / tab new / tab select --tab <targetId>`
    ——可以**固定一个 tab 复用**，而不是每次 open 导航。
  - 命名 session（`browser codexbar ...`）本身就保持 tab/state 存活；
    owned session 有 10 分钟 idle timeout，`OPENCLI_BROWSER_IDLE_TIMEOUT`
    可调。
  - `browser <session> bind` 可附着到用户手动开的 tab，无 idle 关闭。
  - daemon 有 WS 心跳（15s ping，2 次 miss 断开）；`browser doctor`
    命令可做健康检查。

### 4.2 可做的改进（按成本排序）

1. **固定 tab 复用**：一轮开始时 `tab list` 找到已开的 provider tab
   （或 `tab new` 一次），之后所有 eval 用 `--tab <targetId>` 打到同一
   tab，**不再每次 open 导航**。消除"导航中 eval"这个 -1 主因。
   成本：改 `evalInPage`，小。
2. **导航与 eval 分离**：只有 tab URL 不对时才 `open`；URL 已对就直接
   eval。SPA 的 session 不会因为不导航而丢（cookie 在浏览器里）。
3. **健康检查前置**：每轮先 `browser doctor`（或一次轻量 eval
   `1+1`）确认 daemon+扩展+tab 链路活着，死了就重连/重建 tab 再开始
   这一轮，而不是每个 provider 各自撞墙重试。
4. **调大 idle timeout**：`OPENCLI_BROWSER_IDLE_TIMEOUT` 设大（比如
   3600s），避免 15 分钟间隔里 tab 被回收、下次又冷启动。
5. **HTTP -1 的进一步归因**：如果还想细查，opencli 的错误 envelope
   里有 code（`BrowserCommandError` / stale page identity / target-
   navigation），可以在 fetcher 里把 stderr 保留下来分类统计，看 -1
   到底是 tab 没了、扩展断连、还是页面 settle 中。目前代码把 stderr
   揉成一句话，丢了结构。

### 4.3 结论

opencli 桥**不是必须换**。它的问题是"每次重新导航 + 没有健康检查"，
不是扩展/守护进程本身不可靠。方案 B 的 1–3 做好之后，剩余 provider
的稳定性大概率够用。**真正该做的是把 codex 从桥上拿掉（方案 A）**——
那是唯一一个连"需要浏览器"这个前提都不成立的 provider。

---

## 5. 分方案成本/稳定性/维护负担

| 方案 | 一次性成本 | 稳定性 | 维护负担 | 风险 |
| --- | --- | --- | --- | --- |
| A. auth.json 直连 codex | 小：读 JSON + 2 个 GET + 内存 refresh | 高（无浏览器、无桥） | 低：token 失效就报 `codex login` | refresh_token 竞态（不写回即可控）；OpenAI 改 auth 流程需跟进 |
| B. opencli tab 复用+健康检查 | 中：改 evalInPage + tab 管理 | 中–高 | 低：用现有 opencli 命令 | 桥本身故障仍在（扩展断连等） |
| C. Playwright attach Chrome | 中–高：装 playwright + 重启 Chrome 加 CDP flag | 高 | 中：跟 Playwright 版本、CF 检测演进 | 侵入用户浏览器；headless 不可用 |
| D. curl-impersonate | 小 | 对 CF JS challenge 无效 | 低 | 解决不了 codex 的问题 |
| E. cf_clearance 导出 | 小 | 差（30–120min 过期 + 指纹绑定） | 高（要反复重导） | 已排除 |

---

## 6. 建议落地顺序

1. **codex 改走 auth.json 直连**（方案 A）：读 `~/.codex/auth.json`，
   access_token 过期就用 refresh_token 在内存里换，再打 wham/usage +
   rate-limit-reset-credits。这是本轮收益最大、风险最小的改动。
2. **其余 provider 保留桥，做方案 B 的 1–3**（固定 tab、导航/eval 分离、
   每轮健康检查）。
3. Playwright（方案 C）**暂不引入**，作为桥彻底不行时的备选记录在案。
