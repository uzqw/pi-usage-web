// Guarded HTTP layer for direct provider fetches (replaces the opencli
// browser bridge). Anti-abuse rules from NO-BRIDGE-DESIGN.md §4.4:
//
//   - 401/403 are terminal: no retry, surfaced as no-session.
//   - 429 honors Retry-After clamped to <=10s, retried once.
//   - 408/5xx/network errors back off ~2s then ~5s, retried once.
//   - Cloudflare challenges (cf-mitigated header, "Just a moment" body)
//     abort immediately — never try to solve or route around them.
//   - 2 consecutive 403/429/CF rejections put the provider in cooldown for
//     the rest of the round; fetch.mjs clears it each round (下轮再试).
//   - redirect: "manual" — no cross-origin redirect following, no cookie
//     jar, no cache. Callers serialize requests per provider (>=500ms gaps).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.4);

const consecBlocks = new Map();

/** Reset the per-provider block counters at the start of each round. */
export function beginRound() {
  consecBlocks.clear();
}

/** True once a provider has hit 2 consecutive 403/429/CF rejections. */
export function isCoolingDown(providerId) {
  return (consecBlocks.get(providerId) || 0) >= 2;
}

function noteBlock(providerId) {
  consecBlocks.set(providerId, (consecBlocks.get(providerId) || 0) + 1);
}

export function noteSuccess(providerId) {
  consecBlocks.delete(providerId);
}

export function noSession(status, hint) {
  const e = new Error(`no session (HTTP ${status})${hint ? ` — ${hint}` : ""}`);
  e.code = "no-session";
  return e;
}

export function httpErr(msg) {
  const e = new Error(msg);
  e.code = "error";
  return e;
}

function cfErr(providerId) {
  const e = new Error("cloudflare challenge — giving up (not retried)");
  e.code = "error";
  e.blocked = true;
  noteBlock(providerId);
  return e;
}

async function looksLikeCfChallenge(res) {
  if ((res.headers.get("cf-mitigated") || "").includes("challenge")) return true;
  if (res.status !== 403 && res.status !== 503) return false;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return false;
  const head = (await res.clone().text()).slice(0, 8192);
  return /Just a moment|cf-chl-|__cf_chl|challenge-platform/i.test(head);
}

/**
 * fetch() with the rules above baked in. Returns the Response on any status
 * that isn't terminal (caller still checks res.status); throws noSession on
 * 401/403, a blocked error on CF challenge / repeated 429, and a plain error
 * after the single network/5xx retry is exhausted.
 */
export async function guardedFetch(providerId, url, init = {}) {
  const { timeoutMs = 15_000, ...rest } = init;
  if (isCoolingDown(providerId)) {
    throw httpErr(`${providerId}: cooling down after repeated blocks — skipped this round`);
  }
  let retried429 = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        cache: "no-store",
        ...rest,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt === 0) {
        await sleep(jitter(2000));
        continue;
      }
      throw httpErr(`${providerId}: network error: ${e.message}`);
    }
    if (await looksLikeCfChallenge(res)) throw cfErr(providerId);
    if (res.status === 401 || res.status === 403) {
      noteBlock(providerId);
      throw noSession(res.status);
    }
    if (res.status === 429) {
      noteBlock(providerId);
      if (!retried429) {
        retried429 = true;
        const ra = Math.min(10, Number(res.headers.get("retry-after")) || 5);
        await sleep(jitter(ra * 1000));
        continue;
      }
      throw httpErr(`${providerId}: HTTP 429 after Retry-After retry`);
    }
    if ((res.status === 408 || res.status >= 500) && attempt === 0) {
      await sleep(jitter(5000));
      continue;
    }
    if (res.status >= 200 && res.status < 300) noteSuccess(providerId);
    return res;
  }
  throw httpErr(`${providerId}: unreachable`); // loop always returns/throws
}
