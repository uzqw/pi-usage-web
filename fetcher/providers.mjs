// Provider fetchers over plain node HTTP. Credentials come from local config
// files the CLIs already write (~/.codex/auth.json, ~/.pi/agent/auth.json)
// or from the user's Chrome profile via chrome-credentials.mjs (cookies /
// localStorage). The opencli browser bridge is gone; guardedFetch in
// http.mjs carries the anti-abuse rules (no 401/403 retry, clamped 429
// retry, CF challenge abort, consecutive-block cooldown).
//
// Each fetch() returns a normalized snapshot or throws {code:"no-session"|"error"}.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCookieHeader, getLocalStorage, chromeUserAgent } from "./chrome-credentials.mjs";
import { guardedFetch, noSession, httpErr as err } from "./http.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JSON_ACCEPT = "application/json, text/plain, */*";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const LANG = "en-US,en;q=0.9";

// ------------------------------------------------------------------- codex

// Codex: prefer the OAuth entry pi agent keeps fresh in
// ~/.pi/agent/auth.json ("openai-codex": access/refresh/expires-ms/
// accountId). ~/.codex/auth.json is the READ-ONLY fallback
// (docs/codex-oauth.md: refresh+writeback belong to the Codex CLI).
// Refreshes happen in memory only — never write back, to avoid the
// refresh-token rotation race with the CLI/pi. Total failure => tell the
// user `codex login` or configure pi agent.
const PI_AUTH = join(homedir(), ".pi/agent/auth.json");
const CODEX_AUTH = join(homedir(), ".codex/auth.json");
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// pi agent OAuth credential: {type:"oauth", access, refresh, expires(ms)}.
async function piOAuthEntry(key) {
  try {
    const e = JSON.parse(await readFile(PI_AUTH, "utf8"))[key];
    return e && e.type === "oauth" && e.access ? e : null;
  } catch {
    return null;
  }
}

async function codexRefresh(refreshToken, accountId) {
  let res;
  try {
    res = await guardedFetch("codex", "https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } catch (e) {
    // guardedFetch throws on 401 before we can read the body; a rejected
    // refresh (e.g. refresh_token_reused — the stored token was rotated by
    // the CLI/pi or a previous in-memory refresh) means the session is dead.
    if (e.code === "no-session") throw noSession(401, "refresh token rejected");
    throw e;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) throw noSession(res.status, "refresh failed");
  return { token: body.access_token, accountId };
}

async function codexAccessToken() {
  let piErr = null;
  const pi = await piOAuthEntry("openai-codex");
  if (pi) {
    if (Number(pi.expires) > Date.now() + 60_000) {
      return { token: pi.access, accountId: pi.accountId };
    }
    if (pi.refresh) {
      try {
        return await codexRefresh(pi.refresh, pi.accountId);
      } catch (e) {
        piErr = e; // fall through to the CLI credential file
      }
    }
  }
  let auth;
  try {
    auth = JSON.parse(await readFile(CODEX_AUTH, "utf8"));
  } catch {
    throw noSession(0, piErr
      ? `pi agent token expired, refresh failed: ${piErr.message}; ~/.codex/auth.json missing — run \`codex login\` or configure pi agent`
      : "no pi agent openai-codex token and ~/.codex/auth.json missing — run `codex login` or configure pi agent");
  }
  const t = auth.tokens || {};
  if (t.access_token) {
    try {
      const payload = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString());
      if (payload.exp && payload.exp * 1000 > Date.now() + 60_000) {
        return { token: t.access_token, accountId: t.account_id };
      }
    } catch {}
  }
  if (!t.refresh_token) {
    throw noSession(0, "no refresh_token — run `codex login` or configure pi agent");
  }
  try {
    return await codexRefresh(t.refresh_token, t.account_id);
  } catch (e) {
    if (e.code === "no-session") {
      throw noSession(e.status, `${e.message} — run \`codex login\` or configure pi agent`);
    }
    throw e;
  }
}

export async function fetchCodex() {
  const { token, accountId } = await codexAccessToken();
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "CodexBar/1.0",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };
  const usage = await guardedFetch("codex", "https://chatgpt.com/backend-api/wham/usage", {
    headers: h,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  if (usage.status !== 200 || !usage.body) throw err(`codex usage HTTP ${usage.status}`);
  await sleep(500); // >=500ms between same-provider requests
  const resetCredits = await guardedFetch(
    "codex",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    { headers: { ...h, "OpenAI-Beta": "codex-1", originator: "Codex Desktop" } },
  )
    .then(async (r) => (r.ok ? r.json().catch(() => null) : null))
    .catch(() => null); // best-effort enrichment
  return normalizeCodex(usage.body, resetCredits);
}

function normalizeCodex(u, resetCredits) {
  const rl = u.rate_limit || {};
  const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
  const win = (label, w) =>
    w && { label, usedPercent: w.used_percent, resetAt: iso(w.reset_at) };
  const windows = [
    win("5h window", rl.primary_window),
    win("Weekly", rl.secondary_window),
  ].filter(Boolean);

  // Model-specific lanes (CodexAdditionalRateLimitMapper): Spark gets stable
  // 5h/weekly pair, other named limits take primary ?? secondary.
  for (const e of u.additional_rate_limits || []) {
    const name = e.limit_name || e.metered_feature || "Codex extra limit";
    const erl = e.rate_limit || {};
    const spark = /spark/i.test(`${e.limit_name || ""} ${e.metered_feature || ""}`);
    if (spark) {
      const sparkWin = (label, w, fbMins) => {
        if (!w) return null;
        const mins = w.limit_window_seconds > 0 ? w.limit_window_seconds / 60 : 0;
        const kind = mins > 0 && mins <= 360 ? "5-hour" : mins >= 8640 ? "Weekly" : fbMins;
        return win(`Codex Spark ${kind || label}`, w);
      };
      windows.push(
        sparkWin("5-hour", erl.primary_window, "5-hour"),
        sparkWin("Weekly", erl.secondary_window, "Weekly"),
      );
    } else {
      windows.push(win(name, erl.primary_window || erl.secondary_window));
    }
  }
  windows.push(win("Code review", u.code_review_rate_limit?.rate_limit?.primary_window));

  // Monthly spend-control cap (SpendControlLimitSnapshot: remaining_percent +
  // reset_at|resets_at) — precedence: root, then rate_limit, then spend_control.
  const il =
    u.individual_limit ||
    u.individualLimit ||
    rl.individual_limit ||
    rl.individualLimit ||
    u.spend_control?.individual_limit ||
    u.spendControl?.individualLimit;
  if (il && Number(il.limit) > 0) {
    const limit = Number(il.limit);
    const used = Number(il.used) || 0;
    const pct =
      il.remaining_percent != null || il.remainingPercent != null
        ? 100 - Number(il.remaining_percent ?? il.remainingPercent)
        : (used / limit) * 100;
    windows.push({
      label: "Monthly credit limit",
      usedPercent: Math.min(100, Math.max(0, Math.round(pct * 10) / 10)),
      used,
      limit,
      resetAt: iso(il.reset_at ?? il.resets_at ?? il.resetsAt),
    });
  }

  // Reset cards: prefer the detailed endpoint (title + expiry per card),
  // fall back to the summary count embedded in wham/usage.
  const now = Date.now();
  let cards = (resetCredits?.credits || []).filter(
    (c) => c.status === "available" && (!c.expires_at || Date.parse(c.expires_at) > now),
  );
  if (!cards.length && (resetCredits?.available_count ?? u.rate_limit_reset_credits?.available_count) > 0) {
    const n = resetCredits?.available_count ?? u.rate_limit_reset_credits.available_count;
    cards = Array.from({ length: n }, () => ({ expires_at: null }));
  }
  for (const c of cards) {
    windows.push({
      label: c.title || "Reset credit",
      resetAt: c.expires_at ? new Date(c.expires_at).toISOString() : null,
    });
  }

  const credits = u.credits || {};
  return {
    status: "ok",
    plan: u.plan_type || null,
    email: u.email || null,
    windows: windows.filter(Boolean),
    credits: credits.has_credits
      ? { balance: Number(credits.balance) || 0, unlimited: !!credits.unlimited }
      : null,
  };
}

// -------------------------------------------------------------------- kimi

// Kimi Code: pure API-key path (the credential the official CLI uses).
// api.kimi.com reports the account's own 5-hour/7-day Code windows,
// agent-gw.kimi.com reports the plan and the monthly Kimi+Code pool.
export async function fetchKimi() {
  const apiKey = await kimiCodeAPIKey();
  if (!apiKey) throw noSession(0, "no kimi-coding key");
  const snapshot = normalizeKimiCode(await fetchKimiCode(apiKey));
  if (!snapshot) throw err("kimi: API returned no usable usage data");
  return snapshot;
}

// Level names from the V1 membership goods catalog (KimiModels.planName).
const KIMI_CODE_LEVELS = {
  LEVEL_FREE: "Adagio",
  LEVEL_TRIAL: "Andante",
  LEVEL_BASIC: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
};

// Env first, then the credential files the local Kimi tooling already writes.
async function kimiCodeAPIKey() {
  const fromEnv = (process.env.KIMI_CODE_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const sources = [
    [`${process.env.HOME}/.pi/agent/auth.json`, (d) => d["kimi-coding"]?.key || d.kimi?.key],
    [`${process.env.HOME}/.kimi-code/credentials/kimi-code.json`, (d) => d.access_token || d.accessToken],
  ];
  for (const [file, pick] of sources) {
    try {
      const key = String(pick(JSON.parse(await readFile(file, "utf8"))) || "").trim();
      if (key) return key;
    } catch {}
  }
  return null;
}

async function fetchKimiCode(apiKey) {
  const get = (url) =>
    guardedFetch("kimi", url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "CodexBar/1.0" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const [usage, gateway] = await Promise.all([
    get("https://api.kimi.com/coding/v1/usages"),
    get("https://agent-gw.kimi.com/coding/v1/usages"),
  ]);
  return { usage, gateway };
}

// The console's three lanes: the monthly "Total usage" pool, then the Code
// 5-hour and 7-day allowances.
function normalizeKimiCode({ usage, gateway }) {
  if (!usage && !gateway) return null;
  const windows = [];

  const pool = gateway?.totalQuota;
  const limit = kimiNum(pool?.limit);
  const remaining = kimiNum(pool?.remaining);
  if (limit > 0 && remaining >= 0 && remaining <= limit) {
    windows.push({
      label: "Total usage",
      usedPercent: kimiPercent((limit - remaining) / limit),
      used: limit - remaining,
      limit,
      resetAt: kimiISO(pool?.resetTime),
    });
  }

  // Ratios are the console's own numbers; the detail counters round to whole
  // requests, so only fall back to them when the ratio is absent.
  const ratioWindow = (label, node, detail) => {
    const ratio = kimiNum(node?.used_ratio);
    if (ratio != null && ratio >= 0) {
      return { label, usedPercent: kimiPercent(ratio), resetAt: kimiISO(node?.reset_time) };
    }
    const detailLimit = kimiNum(detail?.limit);
    if (!(detailLimit > 0)) return null;
    const used = kimiNum(detail?.used) ?? 0;
    return {
      label,
      usedPercent: kimiPercent(used / detailLimit),
      used,
      limit: detailLimit,
      resetAt: kimiISO(detail?.resetTime),
    };
  };
  const fiveHour = ratioWindow("5-hour usage", usage?.usages?.limit_5h, usage?.limits?.[0]?.detail);
  if (fiveHour) windows.push(fiveHour);
  const sevenDay = ratioWindow("7-day usage", usage?.usages?.limit_7d, usage?.usage);
  if (sevenDay) windows.push(sevenDay);

  const level = gateway?.user?.membership?.level;
  const plan = level ? KIMI_CODE_LEVELS[level] || level : null;
  if (!windows.length && !plan) return null;
  return { status: "ok", plan, windows, credits: null };
}

function kimiNum(v) {
  return v == null || v === "" ? null : Number(v);
}

function kimiPercent(ratio) {
  return Math.min(100, Math.max(0, Math.round(ratio * 1000) / 10));
}

function kimiISO(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ------------------------------------------------------------------ ollama

// Ollama: quota windows only exist on the server-rendered settings page, so
// replay the Chrome session cookie and parse the HTML (mirrors
// OllamaUsageParser — "Monthly usage" / "Weekly usage" blocks, "N% used" or
// "$x of $y used", reset via data-time).
export async function fetchOllama() {
  const cookie = getCookieHeader("ollama.com");
  if (!cookie) throw noSession(0, "no ollama.com cookies in Chrome");
  const res = await guardedFetch("ollama", "https://ollama.com/settings", {
    timeoutMs: 20_000,
    headers: {
      Cookie: cookie,
      Accept: HTML_ACCEPT,
      "Accept-Language": LANG,
      "User-Agent": chromeUserAgent(),
    },
  });
  // Logged-out sessions redirect to signin.ollama.com (manual redirects, so
  // we see the 3xx directly).
  if (res.status >= 300 && res.status < 400) throw noSession(res.status);
  const html = await res.text();
  if (res.status !== 200) throw err(`ollama settings HTTP ${res.status}`);
  if (/signin\.ollama\.com|\/signin/.test(html.slice(0, 2000))) throw noSession(302);
  return normalizeOllama(html);
}

function normalizeOllama(html) {
  const pick = (label) => {
    const i = html.indexOf(label);
    if (i < 0) return null;
    // Bound the block at the next usage label so fields don't bleed across.
    const tail = html.slice(i + label.length, i + label.length + 4000);
    const next = ["Monthly usage", "Session usage", "Hourly usage", "Weekly usage"]
      .filter((l) => l !== label)
      .map((l) => tail.indexOf(l))
      .filter((j) => j >= 0)
      .sort((a, b) => a - b)[0];
    const block = next != null ? tail.slice(0, next) : tail;
    let usedPercent = null;
    let m = block.match(/([0-9]+(?:\.[0-9]+)?)\s*%\s*used/i);
    if (m) usedPercent = Number(m[1]);
    if (usedPercent == null) {
      m = block.match(/\$([0-9,]+(?:\.[0-9]+)?)\s+of\s+\$([0-9,]+(?:\.[0-9]+)?)\s+used/i);
      if (m) {
        const used = Number(m[1].replace(/,/g, ""));
        const limit = Number(m[2].replace(/,/g, ""));
        if (limit > 0) usedPercent = Math.round((used / limit) * 1000) / 10;
      }
    }
    if (usedPercent == null) {
      m = block.match(/width:\s*([0-9]+(?:\.[0-9]+)?)%/i);
      if (m) usedPercent = Number(m[1]);
    }
    if (usedPercent == null) return null;
    const t = block.match(/data-time="([^"]+)"/);
    return { usedPercent, resetAt: t ? t[1] : null };
  };
  const plan =
    (html.match(/Included usage\s*<\/span>\s*<span[^>]*>([^<]+)<\/span/) ||
      html.match(/Cloud Usage\s*<\/span>\s*<span[^>]*>([^<]+)<\/span/) || [])[1]?.trim() || null;
  const email = (html.match(/id="header-email"[^>]*>([^<]+)</) || [])[1]?.trim() || null;
  const windows = [];
  const monthly = pick("Monthly usage");
  if (monthly) windows.push({ label: "Monthly", ...monthly });
  const session = pick("Session usage") || pick("Hourly usage");
  if (session) windows.push({ label: "Session", ...session });
  const weekly = pick("Weekly usage");
  if (weekly) windows.push({ label: "Weekly", ...weekly });
  if (!windows.length) {
    if (/sign in|log in/i.test(html) && !/usage/i.test(html)) throw noSession(401);
    throw err("ollama: no usage blocks on settings page");
  }
  return { status: "ok", plan, email, windows };
}

// ------------------------------------------------------------- commandcode

// CommandCode: better-auth cookie on api.commandcode.ai billing endpoints
// (mirrors CommandCodeUsageFetcher — credits + subscriptions).
export async function fetchCommandCode() {
  const cookie = getCookieHeader("commandcode.ai");
  if (!cookie) throw noSession(0, "no commandcode.ai cookies in Chrome");
  const headers = {
    Cookie: cookie,
    Accept: JSON_ACCEPT,
    "Accept-Language": LANG,
    Origin: "https://commandcode.ai",
    Referer: "https://commandcode.ai/",
    "User-Agent": chromeUserAgent(),
  };
  // ponytail: 45s — api.commandcode.ai stalls ~15-16s before answering this
  // endpoint (session validation), so the 15s default always times out.
  const credits = await guardedFetch(
    "commandcode",
    "https://api.commandcode.ai/internal/billing/credits",
    { headers, timeoutMs: 45_000 },
  ).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  if (credits.status !== 200 || !credits.body) {
    throw err(`commandcode credits HTTP ${credits.status}`);
  }
  await sleep(500);
  const sub = await guardedFetch(
    "commandcode",
    "https://api.commandcode.ai/internal/billing/subscriptions",
    { headers },
  )
    .then(async (r) => (r.ok ? r.json().catch(() => null) : null))
    .catch(() => null); // best-effort
  return normalizeCommandCode({ credits: credits.body, sub });
}

// Monthly grant sizes (USD) keyed by planId — credits endpoint only reports
// remaining, so totals come from the plan catalog like CommandCodePlanCatalog.
const COMMANDCODE_PLAN_MONTHLY_USD = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-max": 150,
  "individual-ultra": 300,
};

function normalizeCommandCode({ credits, sub }) {
  // better-auth error bodies carry success:false — treat as a failed fetch,
  // not an empty account (a stale session cookie returns HTTP 500 here).
  if (credits.success === false) {
    throw err(`commandcode: ${credits.error?.message || credits.error?.code || "API error"}`);
  }
  const c = credits.credits || {};
  const wl = credits.windowLimits || c.windowLimits || {};
  const win = (w, label, defMin) => {
    if (!w || !(Number(w.cap) > 0)) return null;
    const cap = Number(w.cap);
    const used = Number(w.used ?? 0);
    return {
      label,
      usedPercent: Math.round((used / cap) * 1000) / 10,
      used,
      limit: cap,
      resetAt: w.resetAt ? new Date(Number(w.resetAt) > 1e12 ? Number(w.resetAt) : Number(w.resetAt) * 1000).toISOString() : null,
    };
  };
  const plan =
    sub?.success && sub?.data ? sub.data.planId || null : null;
  const monthlyRemaining = Number(c.monthlyCredits);
  const monthlyTotal = plan ? COMMANDCODE_PLAN_MONTHLY_USD[plan.toLowerCase()] : null;
  const periodEnd = sub?.data?.currentPeriodEnd
    ? new Date(sub.data.currentPeriodEnd).toISOString()
    : null;
  const windows = [
    win(wl.fiveHour, "5h window"),
    win(wl.weekly, "Weekly"),
    // Monthly grant: used = plan total - remaining (mirrors makeMonthlyWindow).
    monthlyTotal > 0 && Number.isFinite(monthlyRemaining)
      ? {
          label: "Monthly",
          usedPercent:
            Math.round(
              (Math.max(0, Math.min(monthlyTotal, monthlyTotal - monthlyRemaining)) /
                monthlyTotal) * 1000) / 10,
          used: Math.round(Math.max(0, Math.min(monthlyTotal, monthlyTotal - monthlyRemaining)) * 100) / 100,
          limit: monthlyTotal,
          resetAt: periodEnd,
        }
      : null,
  ].filter(Boolean);
  return {
    status: "ok",
    plan,
    windows,
    credits: Number.isFinite(monthlyRemaining)
      ? { balance: Math.round((monthlyRemaining + Number(c.purchasedCredits ?? 0)) * 100) / 100 }
      : null,
  };
}

// -------------------------------------------------------------------- grok

// Grok: primary path is the CLI billing proxy (mirrors
// GrokCreditsProxyFetcher): GET cli-chat-proxy.grok.com/v1/billing?format=credits
// with the bearer from ~/.grok/auth.json (map keyed by scope URL — prefer the
// `https://auth.x.ai::<client-id>` OIDC entry, fall back to the legacy
// accounts.x.ai/sign-in scope, per GrokAuth.selectPreferredEntry). Fallback is
// the grok.com grpc-web cookie path (kept for when auth.json is absent but a
// browser session exists — it may still hit the WKE keypair wall upstream).
const GROK_AUTH = join(homedir(), ".grok/auth.json");
const GROK_OIDC_PREFIX = "https://auth.x.ai::";
const GROK_LEGACY_SCOPE = "https://accounts.x.ai/sign-in";

// pi agent's "xai" OAuth entry shares the xAI account system — its bearer
// works on the grok CLI billing proxy. Refresh goes to pi's own client.
const XAI_PI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

// Returns a usable bearer token, or null when there is no credential worth
// trying (missing file, no entry, expired without a working refresh).
async function grokAccessToken() {
  const env = (process.env.GROK_OAUTH_TOKEN || "").trim();
  if (env) return env;
  const pi = await piOAuthEntry("xai");
  if (pi) {
    if (Number(pi.expires) > Date.now() + 60_000) return pi.access;
    if (pi.refresh) {
      try {
        const res = await guardedFetch("grok", "https://auth.x.ai/oauth2/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: XAI_PI_CLIENT_ID,
            refresh_token: pi.refresh,
          }),
        });
        const body = await res.json().catch(() => null);
        if (body?.access_token) return body.access_token;
      } catch {} // rejected/blocked — fall through to ~/.grok/auth.json
    }
  }
  let root;
  try {
    root = JSON.parse(await readFile(GROK_AUTH, "utf8"));
  } catch {
    return null;
  }
  let oidc = null;
  let legacy = null;
  for (const [scope, entry] of Object.entries(root || {})) {
    if (!entry || typeof entry !== "object" || !entry.key) continue;
    if (scope.startsWith(GROK_OIDC_PREFIX)) oidc = oidc || { scope, entry };
    else if (scope === GROK_LEGACY_SCOPE || scope.includes("/sign-in")) {
      legacy = legacy || { scope, entry };
    }
  }
  const sel = oidc || legacy;
  if (!sel) return null;
  const exp = Date.parse(sel.entry.expires_at || "");
  if (Number.isNaN(exp) || Date.now() < exp) return sel.entry.key;
  // Expired: best-effort refresh against the xAI OIDC endpoint (the native
  // app leaves refresh to `grok login`; we try once since the CLI may be
  // absent, then give up to the cookie path).
  const rt = sel.entry.refresh_token;
  const clientId =
    sel.entry.oidc_client_id ||
    (sel.scope.startsWith(GROK_OIDC_PREFIX) ? sel.scope.slice(GROK_OIDC_PREFIX.length) : null);
  if (!rt || !clientId) return null;
  try {
    const res = await guardedFetch("grok", "https://auth.x.ai/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }),
    });
    const body = await res.json().catch(() => null);
    return body?.access_token || null;
  } catch {
    return null; // CF-blocked or rejected — caller falls back
  }
}

export async function fetchGrok() {
  const token = await grokAccessToken();
  let proxyErr = null;
  if (token) {
    try {
      const res = await guardedFetch(
        "grok",
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-xai-token-auth": "xai-grok-cli",
            Accept: "application/json",
            "User-Agent": "CodexBar",
          },
        },
      ).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
      if (res.status === 200 && res.body) return normalizeGrokCredits(res.body);
      proxyErr = err(`grok credits proxy HTTP ${res.status}`);
    } catch (e) {
      proxyErr = e; // rejected token / blocked — try the cookie path
    }
  }
  const cookie = getCookieHeader("grok.com");
  if (!cookie) {
    if (proxyErr?.code === "no-session") {
      throw noSession(proxyErr.status ?? 401, "grok token rejected — run `grok login` or configure pi agent");
    }
    if (proxyErr && token) throw proxyErr;
    throw noSession(0, "no pi agent xai token, no ~/.grok/auth.json, no grok.com cookies — run `grok login` or configure pi agent");
  }
  const res = await guardedFetch(
    "grok",
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        Accept: "*/*",
        Origin: "https://grok.com",
        Referer: "https://grok.com/",
        "User-Agent": chromeUserAgent(),
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    },
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200) throw err(`grok billing HTTP ${res.status}`);
  if (!buf.length) {
    throw noSession(0, "grok.com browser session logged out — sign in at grok.com or run `grok login`");
  }
  return normalizeGrok(buf);
}

// Port of GrokCreditsProxyFetcher.parseSnapshot: creditUsagePercent wins,
// then on-demand used/cap, then period-end-only. SuperGrok Heavy with no
// percent is unknown usage (null), not 0%.
function normalizeGrokCredits(body) {
  const config = body?.config;
  if (!config || typeof config !== "object") throw err("grok: unparseable credits response");
  const plan = grokPlanName(config.subscriptionTier ?? body.subscriptionTier);
  const resetRaw = config.currentPeriod?.end ?? config.billingPeriodEnd;
  const resetAt = resetRaw && !Number.isNaN(Date.parse(resetRaw))
    ? new Date(resetRaw).toISOString()
    : null;
  let usedPercent = null;
  const pct = Number(config.creditUsagePercent);
  if (Number.isFinite(pct)) {
    usedPercent = Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
  } else {
    const cap = Number(config.onDemandCap?.val);
    const used = Number(config.onDemandUsed?.val);
    if (cap > 0 && Number.isFinite(used)) {
      usedPercent = Math.min(100, Math.max(0, Math.round((used / cap) * 1000) / 10));
    }
  }
  if (usedPercent == null && !resetAt) throw err("grok: unparseable credits response");
  return {
    status: "ok",
    plan,
    windows: [{ label: "Credits", usedPercent, resetAt }],
  };
}

function grokPlanName(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  const n = t.toLowerCase().replace(/[^a-z]/g, "");
  if (n === "supergrokheavy" || n === "heavy") return "SuperGrok Heavy";
  if (n === "supergrok") return "SuperGrok";
  return t;
}

function normalizeGrok(bytes) {
  // grpc-web frames: [flags][len4][payload]; keep data frames (flags&0x80==0).
  const frames = [];
  for (let i = 0; i + 5 <= bytes.length; ) {
    const flags = bytes[i];
    const len = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4];
    const end = i + 5 + len;
    if (len < 0 || end > bytes.length) break;
    if ((flags & 0x80) === 0) frames.push(bytes.slice(i + 5, end));
    i = end;
  }
  const payloads = frames.length ? frames : [bytes];
  const fixed32 = [];
  const varints = [];
  const scan = (buf, path, depth) => {
    if (depth > 6) return;
    for (let i = 0; i < buf.length; ) {
      // varint key
      let key = 0, shift = 0, j = i;
      for (; j < buf.length && j < i + 5; j++) {
        key |= (buf[j] & 0x7f) << shift;
        if (!(buf[j] & 0x80)) break;
        shift += 7;
      }
      if (j >= buf.length) return;
      const field = key >>> 3, wire = key & 7;
      i = j + 1;
      const p = [...path, field];
      if (wire === 0) {
        let v = 0n, s = 0n;
        for (; i < buf.length && i < j + 11; i++) {
          v |= BigInt(buf[i] & 0x7f) << s;
          if (!(buf[i] & 0x80)) { i++; break; }
          s += 7n;
        }
        varints.push({ path: p, value: Number(v) });
      } else if (wire === 5) {
        if (i + 4 > buf.length) return;
        fixed32.push({ path: p, value: new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true) });
        i += 4;
      } else if (wire === 1) {
        i += 8;
      } else if (wire === 2) {
        let len = 0, s = 0;
        for (; i < buf.length && i < j + 6; i++) {
          len |= (buf[i] & 0x7f) << s;
          if (!(buf[i] & 0x80)) { i++; break; }
          s += 7;
        }
        const sub = buf.slice(i, i + len);
        i += len;
        scan(sub, p, depth + 1);
      } else return;
    }
  };
  for (const pl of payloads) scan(pl, [], 0);
  const now = Date.now() / 1000;
  const percent = fixed32
    .filter((f) => f.path[f.path.length - 1] === 1 && f.value >= 0 && f.value <= 100)
    .sort((a, b) => a.path.length - b.path.length)[0]?.value;
  const resets = varints
    .filter((v) => v.value >= 1_700_000_000 && v.value <= 2_100_000_000 && v.value > now)
    .map((v) => v.value);
  if (percent == null && !resets.length) throw err("grok: unparseable billing response");
  return {
    status: "ok",
    windows: [
      {
        label: "Credits",
        usedPercent: percent != null ? Math.round(percent * 10) / 10 : 0,
        resetAt: resets.length ? new Date(Math.min(...resets) * 1000).toISOString() : null,
      },
    ],
  };
}

// ------------------------------------------------------------------- devin

// Devin: app.devin.ai keeps the session token and org metadata in
// localStorage (mirrors DevinSessionImporter + DevinUsageFetcher):
//   token: key ending "auth1_session" → JSON .token ("auth1_..."), or an
//          "auth0spajs@@::" key → nested access_token/accessToken
//   org:   "last-internal-org-for-external-org-v1-<slug>" → internal
//          org-.../org_... id; else inferred from member-info/post-auth
//          blobs (internalOrgId/orgName) or ids embedded in key names
// Quota endpoint: GET /api/<org>/billing/quota/usage with Bearer token and
// x-cog-org-id; tries internal-id, org/<slug>, bare slug, organizations/<id>.
export async function fetchDevin() {
  const ls = getLocalStorage("https://app.devin.ai");
  const j = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const deep = (o, keys, pred) => {
    if (o && typeof o === "object") {
      if (!Array.isArray(o)) for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && pred(v)) return v;
      }
      for (const v of Object.values(o)) {
        const f = deep(v, keys, pred);
        if (f) return f;
      }
    }
    return null;
  };
  const tokPred = (v) => v.length > 20 && (v.startsWith("eyJ") || v.includes("."));
  let token = null;
  for (const [k, v] of Object.entries(ls)) {
    if (!k.endsWith("auth1_session")) continue;
    const t = j(v)?.token;
    if (typeof t === "string" && t.startsWith("auth1_") && t.length > 20) { token = t; break; }
  }
  if (!token) for (const [k, v] of Object.entries(ls)) {
    if (!k.includes("auth0spajs@@::")) continue;
    const t = deep(j(v), ["access_token", "accessToken"], tokPred);
    if (t) { token = t; break; }
  }
  if (!token) for (const v of Object.values(ls)) {
    const t = deep(j(v), ["access_token", "accessToken"], tokPred);
    if (t) { token = t; break; }
  }
  if (!token) throw noSession(401, "no devin token in localStorage");
  const dec = (s) => { const p = j(s); return typeof p === "string" ? p : s; };
  const isInternal = (v) => typeof v === "string" && /^org[-_]/.test(v);
  let slug = null, orgId = null;
  const EXT = "last-internal-org-for-external-org-v1-";
  for (const [k, v] of Object.entries(ls)) {
    if (!k.includes(EXT)) continue;
    const suf = k.slice(k.indexOf(EXT) + EXT.length);
    const id = dec(v);
    if (isInternal(id) && !orgId) orgId = id;
    if (!slug && suf && suf !== "null") slug = suf;
  }
  for (const [k, v] of Object.entries(ls)) {
    const o = j(v);
    if (o) {
      if (!orgId) {
        const c = dec(deep(o, ["internalOrgId", "internal_org_id", "org_id", "orgId"], (x) => !!x) || "");
        if (isInternal(c)) orgId = c;
      }
      if (!slug) {
        const c = deep(o, ["orgName", "org_name", "externalOrgId", "external_org_id"], (x) => !!x);
        if (c && c !== "null" && !isInternal(c)) slug = c.replace(/^org\//, "").replace(/^\/+|\/+$/g, "");
      }
    }
    if (!slug) { const m = k.match(/-org_name-(.+)$/); if (m) slug = m[1]; }
    if (!orgId) { const m = k.match(/org[-_][A-Za-z0-9]{8,}/); if (m && isInternal(m[0])) orgId = m[0]; }
  }
  const paths = [];
  if (orgId) paths.push(`${orgId}/billing/quota/usage`);
  if (slug) {
    paths.push(`org/${slug}/billing/quota/usage`);
    paths.push(`${slug}/billing/quota/usage`);
  }
  if (orgId) paths.push(`organizations/${orgId}/billing/quota/usage`);
  if (!paths.length) {
    throw err("devin: token found but no organization — open the org Usage & Limits page once");
  }
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Accept-Language": LANG,
    Origin: "https://app.devin.ai",
    Referer: "https://app.devin.ai/settings/usage",
    "User-Agent": chromeUserAgent(),
    ...(orgId ? { "x-cog-org-id": orgId } : {}),
  };
  let last = null;
  for (const path of paths) {
    const r = await guardedFetch("devin", `https://app.devin.ai/api/${path}`, { headers });
    const body = await r.json().catch(() => null);
    if (r.status === 200) return normalizeDevin(body, slug || orgId);
    last = { status: r.status, body };
    if (r.status === 401 || r.status === 403) throw noSession(r.status);
    await sleep(500);
  }
  throw err(`devin quota HTTP ${last?.status ?? "?"}`);
}

// Port of DevinUsageParser: daily/weekly percentage + reset, plan name,
// overage balance. Direct keys first, generic recursive fallback after.
function normalizeDevin(body, org) {
  const num = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    return null;
  };
  const pct = (v) => {
    const n = num(v);
    return n == null ? null : n <= 1 ? n * 100 : n;
  };
  const date = (v) => {
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return new Date(t).toISOString();
      const n = num(v);
      if (n != null) return date(n);
    }
    const n = num(v);
    if (n == null || n <= 0) return null;
    return new Date(n > 1e10 ? n : n * 1000).toISOString();
  };
  const win = (percent, reset) => {
    const p = pct(percent);
    return p == null ? null : { usedPercent: Math.min(100, Math.max(0, Math.round(p * 10) / 10)), resetAt: date(reset) };
  };
  // Generic fallback: find an object under a daily/weekly-ish key and pull
  // a percent (used_percent/percent/used+limit/remaining) plus reset date.
  const findWin = (o, match) => {
    if (o && typeof o === "object") {
      if (!Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) {
          if (!match(k)) continue;
          const w = winFrom(v);
          if (w) return w;
        }
      }
      for (const v of Object.values(o)) {
        const f = findWin(v, match);
        if (f) return f;
      }
    }
    return null;
  };
  const winFrom = (v) => {
    const p = pct(v);
    if (p != null) return { usedPercent: Math.min(100, Math.max(0, Math.round(p * 10) / 10)), resetAt: null };
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    let percent = null;
    for (const k of ["used_percent", "usedPercent", "usage_percent", "usagePercent", "percent_used", "percentUsed", "percent"]) {
      percent = pct(v[k]);
      if (percent != null) break;
    }
    if (percent == null)
      for (const k of ["remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining"]) {
        const r = pct(v[k]);
        if (r != null) { percent = 100 - r; break; }
      }
    if (percent == null) {
      const used = ["used", "usage", "used_count", "usedCount", "consumed"].map((k) => num(v[k])).find((x) => x != null);
      const limit = ["limit", "quota", "total", "max", "available"].map((k) => num(v[k])).find((x) => x != null);
      if (used != null && limit > 0) percent = (used / limit) * 100;
    }
    if (percent == null) {
      for (const val of Object.values(v)) {
        const w = winFrom(val);
        if (w) return w;
      }
      return null;
    }
    let resetAt = null;
    for (const [k, val] of Object.entries(v)) {
      if (/reset/i.test(k)) { resetAt = date(val); if (resetAt) break; }
    }
    return { usedPercent: Math.min(100, Math.max(0, Math.round(percent * 10) / 10)), resetAt };
  };
  const findStr = (o, keys) => {
    if (o && typeof o === "object") {
      if (!Array.isArray(o)) for (const k of keys) {
        if (typeof o[k] === "string" && o[k]) return o[k];
      }
      for (const v of Object.values(o)) {
        const f = findStr(v, keys);
        if (f) return f;
      }
    }
    return null;
  };
  const isDaily = (k) => !/hide/i.test(k) && /daily|day/i.test(k);
  const isWeekly = (k) => !/hide/i.test(k) && /weekly|week/i.test(k);
  const daily = body.hide_daily_quota === true
    ? null
    : win(body.daily_percentage, body.daily_reset_at) || findWin(body, isDaily);
  const weekly = win(body.weekly_percentage, body.weekly_reset_at) || findWin(body, isWeekly);
  if (!daily && !weekly) throw err("devin: no quota windows in response");
  const windows = [];
  if (daily) windows.push({ label: "Daily", ...daily });
  if (weekly) windows.push({ label: "Weekly", ...weekly });
  const planRaw = findStr(body, ["plan_name", "planName", "plan", "tier", "subscription_tier", "subscriptionTier"]);
  const plan = planRaw
    ? planRaw.trim().split(/[_-]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")
    : null;
  const over = num(body.overage_balance) ?? (num(body.overage_balance_cents) ?? 0) / 100;
  const displayOrg = org ? org.replace(/^organizations?\//, "") : null;
  return {
    status: "ok",
    plan,
    organization: displayOrg,
    windows,
    credits: over > 0 ? { balance: over } : null,
  };
}

// ---------------------------------------------------------------- opencode

// OpenCode: opencode.ai is a SolidStart app; data comes from `/_server`
// server functions keyed by a fixed X-Server-Id (mirrors
// OpenCodeUsageFetcher). Workspace id is discovered via the workspaces
// server fn. Pay-as-you-go workspaces have no subscription object — monthly
// spend and balance live in the billing payload (fixed-point USD, 1e8).
const OC_WORKSPACES_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const OC_BILLING_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";

export async function fetchOpenCode() {
  const cookie = getCookieHeader("opencode.ai");
  if (!cookie) throw noSession(0, "no opencode.ai cookies in Chrome");
  const srv = async (id, args, referer) => {
    const q = `?id=${id}` + (args ? `&args=${encodeURIComponent(JSON.stringify(args))}` : "");
    const r = await guardedFetch("opencode", `https://opencode.ai/_server${q}`, {
      headers: {
        Cookie: cookie,
        "X-Server-Id": id,
        "X-Server-Instance": `server-fn:${crypto.randomUUID()}`,
        Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
        "Accept-Language": LANG,
        Origin: "https://opencode.ai",
        Referer: referer,
        "User-Agent": chromeUserAgent(),
      },
    });
    return { status: r.status, text: await r.text() };
  };
  const ws = await srv(OC_WORKSPACES_ID, null, "https://opencode.ai/");
  if (ws.status === 401 || ws.status === 403) throw noSession(ws.status);
  const m = ws.text.match(/id\s*:\s*"(wrk_[^"]+)"/) || ws.text.match(/"(wrk_[A-Za-z0-9]+)"/);
  const wrk = m?.[1];
  if (!wrk) throw err(`opencode: no workspace id (HTTP ${ws.status})`);
  await sleep(500);
  const b = await srv(OC_BILLING_ID, [wrk], `https://opencode.ai/workspace/${wrk}`);
  if (b.status === 401 || b.status === 403) throw noSession(b.status);
  if (b.status !== 200 || !b.text) throw err(`opencode billing HTTP ${b.status}`);
  return normalizeOpenCode(b.text, wrk);
}

function normalizeOpenCode(text, workspaceID) {
  if (!/customerID\s*:\s*"/.test(text)) {
    if (/sign in|log in/i.test(text)) throw noSession(401);
    throw err("opencode: no billing payload");
  }
  const num = (field) => {
    const m = text.match(new RegExp(field + "\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)"));
    return m ? Number(m[1]) : null;
  };
  const scale = 100_000_000;
  const monthlyUsage = num("monthlyUsage");
  const monthlyLimit = num("monthlyLimit");
  const balance = num("balance");
  const hasSubscription = /subscription\s*:\s*(?!null)[^,}]/.test(text);
  const windows = [];
  if (monthlyUsage != null || monthlyLimit != null) {
    const used = (monthlyUsage ?? 0) / scale;
    const limit = monthlyLimit && monthlyLimit > 0 ? monthlyLimit : null;
    windows.push({
      label: "Monthly spend",
      used,
      limit,
      usedPercent: limit ? Math.round((used / limit) * 1000) / 10 : null,
    });
  }
  return {
    status: "ok",
    plan: hasSubscription ? "Subscription" : "Pay as you go",
    organization: workspaceID || null,
    windows,
    credits: balance != null ? { balance: balance / scale } : null,
  };
}

// -------------------------------------------------------------- registry

// Providers whose sessions were absent in the leg-1 survey.
export const NO_SESSION_PROVIDERS = [
  { id: "cursor", name: "Cursor" },
  { id: "manus", name: "Manus" },
];

export const PROVIDERS = [
  { id: "codex", name: "Codex", fetch: fetchCodex },
  { id: "kimi", name: "Kimi", fetch: fetchKimi },
  { id: "ollama", name: "Ollama", fetch: fetchOllama },
  { id: "commandcode", name: "CommandCode", fetch: fetchCommandCode },
  { id: "grok", name: "Grok", fetch: fetchGrok },
  { id: "devin", name: "Devin", fetch: fetchDevin },
  { id: "opencode", name: "OpenCode", fetch: fetchOpenCode },
  { id: "xai", name: "xAI", fetch: fetchXAI },
  { id: "openai", name: "OpenAI", fetch: fetchOpenAI },
];

// --------------------------------------------------------------------- xai

// xAI: Management API, key-driven. Mirrors Plugins/xai.js: prepaid balance is
// an inverted USD-cents string, daily spend comes from the analytics /usage
// endpoint (best-effort). Env: XAI_MANAGEMENT_API_KEY + XAI_TEAM_ID.
export async function fetchXAI() {
  const key = process.env.XAI_MANAGEMENT_API_KEY;
  const team = process.env.XAI_TEAM_ID;
  if (!key || !team) throw noSession(0);
  const root = `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team)}`;
  const auth = { Authorization: `Bearer ${key}`, "User-Agent": "CodexBar/1.0" };
  const bal = await guardedFetch("xai", `${root}/prepaid/balance`, { headers: auth }).then(
    async (r) => ({ status: r.status, body: await r.json().catch(() => null) }),
  );
  if (bal.status !== 200 || !bal.body) throw err(`xai balance HTTP ${bal.status}`);
  const raw = bal.body?.total?.val;
  if (typeof raw !== "string" || !/^-?\d+(\.\d+)?$/.test(raw.trim())) {
    throw err("xai: unparseable balance total.val");
  }
  const balance = -Number(raw) / 100;
  const windows = await xaiDailySpend(root, auth);
  return { status: "ok", plan: "Management API", windows, credits: { balance } };
}

async function xaiDailySpend(root, auth) {
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 29);
  start.setUTCHours(0, 0, 0, 0);
  const ts = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  try {
    const res = await fetch(`${root}/usage`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        analyticsRequest: {
          timeRange: { startTime: ts(start), endTime: ts(now), timezone: "Etc/GMT" },
          timeUnit: "TIME_UNIT_DAY",
          values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
          groupBy: [],
          filters: [],
        },
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    if (res.status < 200 || res.status >= 300 || !Array.isArray(res.body?.timeSeries)) return [];
    const totals = {};
    for (const series of res.body.timeSeries) {
      for (const point of series.dataPoints || []) {
        const day = new Date(point.timestamp).toISOString().slice(0, 10);
        const v = Array.isArray(point.values) ? point.values[0] : 0;
        if (Number.isFinite(v)) totals[day] = (totals[day] || 0) + v;
      }
    }
    const total30 = Object.values(totals).reduce((s, v) => s + v, 0);
    const today = totals[now.toISOString().slice(0, 10)] || 0;
    const suffix = res.body.limitReached === true ? " (partial)" : "";
    return [
      { label: "Today spend", used: today, limit: null },
      { label: `Last 30 days${suffix}`, used: total30, limit: null },
    ];
  } catch {
    return []; // history is best-effort; balance still stands
  }
}

// ------------------------------------------------------------------ openai

// OpenAI: organization Admin API, key-driven. Mirrors OpenAIAPIUsageFetcher:
// daily cost buckets via /v1/organization/costs (bucket_width=1d,
// group_by=line_item). Keys without org access fall back to legacy
// /v1/dashboard/billing/credit_grants.
// Env: OPENAI_ADMIN_KEY (or OPENAI_API_KEY) + optional OPENAI_PROJECT_ID.
export async function fetchOpenAI() {
  const key = process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw noSession(0);
  const auth = { Authorization: `Bearer ${key}`, "User-Agent": "CodexBar/1.0" };
  const project = process.env.OPENAI_PROJECT_ID;
  const now = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({
    start_time: String(now - 29 * 86400),
    end_time: String(now),
    bucket_width: "1d",
    limit: "31",
    group_by: "line_item",
  });
  if (project) qs.set("project_ids", project);
  const costs = await guardedFetch("openai", `https://api.openai.com/v1/organization/costs?${qs}`, {
    headers: auth,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  if (costs.status === 200 && Array.isArray(costs.body?.data)) {
    return normalizeOpenAICosts(costs.body, project);
  }
  if (costs.status === 401 || costs.status === 403) {
    const grants = await fetch("https://api.openai.com/v1/dashboard/billing/credit_grants", {
      headers: auth,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    if (grants.status === 200 && grants.body) return normalizeOpenAIGrants(grants.body);
    throw noSession(costs.status);
  }
  throw err(`openai costs HTTP ${costs.status}`);
}

function normalizeOpenAICosts(body, project) {
  const totals = {};
  for (const bucket of body.data) {
    const day = new Date((bucket.start_time ?? 0) * 1000).toISOString().slice(0, 10);
    for (const result of bucket.results || []) {
      const v = result?.amount?.value;
      const n = typeof v === "string" ? Number(v) : v;
      if (Number.isFinite(n)) totals[day] = (totals[day] || 0) + n;
    }
  }
  const total30 = Object.values(totals).reduce((s, v) => s + v, 0);
  const today = totals[new Date().toISOString().slice(0, 10)] || 0;
  return {
    status: "ok",
    plan: project ? `Admin API: ${project}` : "Admin API",
    windows: [
      { label: "Today spend", used: today, limit: null },
      { label: "Last 30 days", used: total30, limit: null },
    ],
  };
}

function normalizeOpenAIGrants(body) {
  return {
    status: "ok",
    plan: "API key",
    credits: {
      balance: Number(body.total_available) || 0,
      granted: Number(body.total_granted) || 0,
      used: Number(body.total_used) || 0,
    },
  };
}
