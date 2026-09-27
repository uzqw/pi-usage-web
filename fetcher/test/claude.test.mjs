// Claude provider unit tests — node --test, zero deps, all network mocked.
//
// Isolation: providers.mjs pins CLAUDE_CREDENTIALS (and chrome-credentials.mjs
// pins its Chrome roots) from os.homedir() AT MODULE LOAD, so HOME must point
// at a fresh tmp dir before the dynamic import below. node --test runs each
// file in its own process, so sibling test files keep their own HOME.
//
// Every case stubs globalThis.fetch; a "network must not be called" handler
// is the default so any unmocked request fails loudly (this project avoids
// real requests to not trip provider anti-abuse).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-test-"));
process.env.HOME = HOME;
process.env.CHROME_PROFILE_DIR = join(HOME, "no-such-chrome"); // belt & braces

// providers.mjs mirrors the OAuth rate-limit cooldown to this real-tmpdir
// file (survives --once fresh processes). Tests must clear it along with the
// in-memory gate, and leave no stale block behind for the real app.
const BLOCK_FILE = join(tmpdir(), "pi-usage-claude-block.json");

const { fetchClaude, __claudeTest: T } = await import("../providers.mjs");
const http = await import("../http.mjs");

// ---- fetch mock ------------------------------------------------------------

let fetchCalls = [];
const NO_NETWORK = async (url) => {
  throw new Error(`network must not be called (got ${url})`);
};
let fetchHandler = NO_NETWORK;

const origFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return fetchHandler(String(url), init);
  };
});
after(() => {
  globalThis.fetch = origFetch;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(BLOCK_FILE, { force: true });
});

const mockFetch = (handler) => {
  fetchCalls = [];
  fetchHandler = handler || NO_NETWORK;
};

const jres = (body, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

const resetState = () => {
  T.claudeBlocked.until = 0; // clear the in-memory OAuth rate-limit gate
  rmSync(BLOCK_FILE, { force: true }); // ... and its on-disk mirror
  http.beginRound(); // clear guardedFetch consecutive-block counters
};

// ---- credentials fixture ---------------------------------------------------

const CRED_DIR = join(HOME, ".claude");
const CRED_PATH = join(CRED_DIR, ".credentials.json");
const writeCreds = (claudeAiOauth) => {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth }));
};
const removeCreds = () => rmSync(CRED_PATH, { force: true });
const liveCreds = (over = {}) => ({
  accessToken: "tok-live",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["user:profile"],
  ...over,
});

// ---- normalizeClaude (pure, no network) -------------------------------------

test("normalizeClaude: five_hour/seven_day 映射 + 钳制 + ISO reset", () => {
  const snap = T.normalizeClaude(
    {
      five_hour: { utilization: 42.36, resets_at: "2026-09-17T10:00:00.000Z" },
      seven_day: { utilization: 150, resets_at: "2026-09-21T00:00:00Z" },
    },
    null,
    null,
    "OAuth",
  );
  assert.equal(snap.status, "ok");
  assert.equal(snap.plan, "Claude (OAuth)");
  assert.equal(snap.email, null);
  assert.equal(snap.windows.length, 2);
  assert.deepEqual(snap.windows[0], {
    label: "5h window",
    usedPercent: 42.4,
    resetAt: "2026-09-17T10:00:00.000Z",
  });
  assert.equal(snap.windows[1].label, "Weekly");
  assert.equal(snap.windows[1].usedPercent, 100); // clamped from 150
  assert.equal(snap.windows[1].resetAt, "2026-09-21T00:00:00.000Z");
});

test("normalizeClaude: 负 utilization 钳到 0", () => {
  const snap = T.normalizeClaude(
    { five_hour: { utilization: -5 } },
    null, null, "Web",
  );
  assert.equal(snap.windows[0].usedPercent, 0);
  assert.equal(snap.windows[0].resetAt, null); // resets_at 缺失 → null
});

test("normalizeClaude: limits[] scoped weekly → '{name} only'，All models 跳过", () => {
  const snap = T.normalizeClaude(
    {
      seven_day: { utilization: 10 },
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 25.5,
          resets_at: "2026-09-20T00:00:00Z",
          scope: { model: { display_name: "Fable" } },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 60,
          scope: { model: { display_name: "All models" } }, // 必须被跳过
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 60,
          scope: { model: { display_name: "All Models" } }, // 大小写不敏感，也跳过
        },
        { kind: "other", group: "weekly", percent: 1, scope: { model: { display_name: "X" } } }, // kind 不符
        { kind: "weekly_scoped", group: "daily", percent: 1, scope: { model: { display_name: "Y" } } }, // group 不符
      ],
    },
    null, null, "OAuth",
  );
  const labels = snap.windows.map((w) => w.label);
  assert.deepEqual(labels, ["Weekly", "Fable only"]);
  assert.deepEqual(snap.windows[1], {
    label: "Fable only",
    usedPercent: 25.5,
    resetAt: "2026-09-20T00:00:00.000Z",
  });
});

test("normalizeClaude: seven_day_routines / seven_day_cowork → Daily Routines", () => {
  const fromRoutines = T.normalizeClaude(
    { seven_day_routines: { utilization: 10, resets_at: "2026-09-18T00:00:00Z" } },
    null, null, "Web",
  );
  assert.deepEqual(fromRoutines.windows.map((w) => w.label), ["Daily Routines"]);

  const fromCowork = T.normalizeClaude(
    { seven_day_cowork: { utilization: 20 } },
    null, null, "Web",
  );
  assert.equal(fromCowork.windows[0].label, "Daily Routines");
  assert.equal(fromCowork.windows[0].usedPercent, 20);

  // 两者同时存在时 routines 优先（|| 短路），不会重复
  const both = T.normalizeClaude(
    { seven_day_routines: { utilization: 1 }, seven_day_cowork: { utilization: 2 } },
    null, null, "Web",
  );
  assert.equal(both.windows.length, 1);
  assert.equal(both.windows[0].usedPercent, 1);
});

test("normalizeClaude: extra_usage → Extra usage，percent = used/limit", () => {
  const snap = T.normalizeClaude(
    { extra_usage: { is_enabled: true, monthly_limit: 200, used_credits: 50 } },
    null, null, "OAuth",
  );
  assert.deepEqual(snap.windows[0], {
    label: "Extra usage",
    usedPercent: 25,
    used: 50,
    limit: 200,
  });
  // used 缺失 → 0；超过 limit → 钳 100
  assert.equal(
    T.normalizeClaude({ extra_usage: { is_enabled: true, monthly_limit: 100 } }, null, null, "OAuth")
      .windows[0].usedPercent,
    0,
  );
  assert.equal(
    T.normalizeClaude({ extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 250 } }, null, null, "OAuth")
      .windows[0].usedPercent,
    100,
  );
  // is_enabled=false → 无窗口 → 抛错
  assert.throws(
    () => T.normalizeClaude({ extra_usage: { is_enabled: false, monthly_limit: 100, used_credits: 9 } }, null, null, "OAuth"),
    (e) => e.code === "error",
  );
});

test("normalizeClaude: 无任何窗口 → 抛 error", () => {
  assert.throws(
    () => T.normalizeClaude({}, null, null, "OAuth"),
    (e) => e.code === "error" && /no usage windows/.test(e.message),
  );
  // utilization 缺失的窗口不算窗口
  assert.throws(
    () => T.normalizeClaude({ five_hour: { resets_at: "2026-09-17T10:00:00Z" } }, null, null, "OAuth"),
    (e) => e.code === "error",
  );
});

test("normalizeClaude: 非法 resets_at → resetAt null，不炸 RangeError", () => {
  const snap = T.normalizeClaude(
    {
      five_hour: { utilization: 10, resets_at: "bogus-not-a-date" },
      seven_day: { utilization: 20, resets_at: "2026-09-21T00:00:00Z" },
    },
    null, null, "OAuth",
  );
  assert.equal(snap.windows.length, 2);
  assert.equal(snap.windows[0].resetAt, null);
  assert.equal(snap.windows[1].resetAt, "2026-09-21T00:00:00.000Z");
});

// ---- claudeAccessToken -------------------------------------------------------

test("claudeAccessToken: 无 credentials 文件 → null", async () => {
  resetState();
  removeCreds();
  mockFetch();
  assert.equal(await T.claudeAccessToken(), null);
  assert.equal(fetchCalls.length, 0);
});

test("claudeAccessToken: access token 未过期 → 直接用，零网络", async () => {
  resetState();
  writeCreds(liveCreds());
  mockFetch();
  assert.equal(await T.claudeAccessToken(), "tok-live");
  assert.equal(fetchCalls.length, 0);
});

test("claudeAccessToken: 过期 + refreshToken → POST platform.claude.com 换发", async () => {
  resetState();
  writeCreds(liveCreds({ accessToken: "tok-old", refreshToken: "rt-1", expiresAt: Date.now() - 1000 }));
  mockFetch(async (url, init) => {
    assert.equal(url, "https://platform.claude.com/v1/oauth/token");
    assert.equal(init.method, "POST");
    const body = String(init.body);
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e/);
    assert.match(body, /refresh_token=rt-1/);
    return jres({ access_token: "tok-new", expires_in: 3600 });
  });
  assert.equal(await T.claudeAccessToken(), "tok-new");
  assert.equal(fetchCalls.length, 1);
});

test("claudeAccessToken: refresh 响应无 access_token → no-session", async () => {
  resetState();
  writeCreds(liveCreds({ refreshToken: "rt-1", expiresAt: Date.now() - 1000 }));
  mockFetch(async () => jres({ error: "invalid_grant" }, 200));
  await assert.rejects(
    () => T.claudeAccessToken(),
    (e) => e.code === "no-session",
  );
});

test("claudeAccessToken: scopes 缺 user:profile → no-session 带提示", async () => {
  resetState();
  writeCreds(liveCreds({ scopes: ["user:email"] }));
  mockFetch();
  await assert.rejects(
    () => T.claudeAccessToken(),
    (e) => e.code === "no-session" && /user:profile/.test(e.message),
  );
  assert.equal(fetchCalls.length, 0); // scope 检查在过期检查之前
});

// ---- fetchClaudeOAuth + 冷却门 ------------------------------------------------

test("fetchClaudeOAuth: 429 → 抛错、claudeBlocked 被设置、恰好重试一次", async () => {
  resetState();
  writeCreds(liveCreds());
  mockFetch(async () => jres("rate limited", 429, { "retry-after": "1" }));
  await assert.rejects(
    () => T.fetchClaudeOAuth(),
    (e) => e.code === "error" && /429/.test(e.message),
  );
  assert.equal(fetchCalls.length, 2); // guardedFetch: 429 重试恰好一次后放弃
  assert.ok(
    T.claudeBlocked.until > Date.now() + 4 * 60_000,
    `claudeBlocked.until 应约为 5 分钟后，实际 ${new Date(T.claudeBlocked.until).toISOString()}`,
  );
});

test("fetchClaude: 冷却期内直接抛，零网络请求", async () => {
  resetState();
  writeCreds(liveCreds());
  T.claudeBlocked.until = Date.now() + 60_000;
  mockFetch();
  await assert.rejects(
    () => fetchClaude(),
    (e) => e.code === "error" && /cooling down/.test(e.message),
  );
  assert.equal(fetchCalls.length, 0);
});

test("fetchClaudeOAuth: 200 → 返回快照", async () => {
  resetState();
  writeCreds(liveCreds());
  mockFetch(async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(init.headers.Authorization, "Bearer tok-live");
    assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.match(init.headers["User-Agent"], /^claude-code\//);
    return jres({
      five_hour: { utilization: 10, resets_at: "2026-09-17T10:00:00.000Z" },
      seven_day: { utilization: 20 },
    });
  });
  const snap = await T.fetchClaudeOAuth();
  assert.equal(snap.status, "ok");
  assert.equal(snap.plan, "Claude (OAuth)");
  assert.deepEqual(snap.windows.map((w) => w.label), ["5h window", "Weekly"]);
});

// ---- fetchClaude fallback 链 ---------------------------------------------------

test("fetchClaude: OAuth no-session(无 credentials) → 走 web → 无 cookie → no-session", async () => {
  resetState();
  removeCreds();
  mockFetch(); // web 阶段也不允许网络：临时 HOME 下 listProfiles() 为 []
  await assert.rejects(
    () => fetchClaude(),
    (e) => e.code === "no-session" && /sessionKey cookie/.test(e.message),
  );
  assert.equal(fetchCalls.length, 0);
});

test("fetchClaude: OAuth 429(非 no-session) → 不走 web，直接抛", async () => {
  resetState();
  writeCreds(liveCreds());
  mockFetch(async (url) => {
    if (url.startsWith("https://claude.ai/")) return jres({}); // web 若被调到会走到这
    return jres("rate limited", 429, { "retry-after": "1" });
  });
  await assert.rejects(
    () => fetchClaude(),
    (e) => e.code === "error" && /429/.test(e.message),
  );
  assert.ok(fetchCalls.every((c) => c.url.startsWith("https://api.anthropic.com/")), "不应发起任何 claude.ai 请求");
});
