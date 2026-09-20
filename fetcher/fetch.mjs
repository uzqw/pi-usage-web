#!/usr/bin/env node
// CodexBar web fetcher: direct HTTP fetches per provider (no browser bridge —
// credentials come from local auth files and the Chrome profile via
// chrome-credentials.mjs), then POSTs normalized snapshots to the PocketBase
// hook. Run on demand (`--once`) or on an interval.
//
//   node fetcher/fetch.mjs --once
//   node fetcher/fetch.mjs            # loop; adaptive interval (see below)
//
// Loop mode is adaptive, mirroring the native AdaptiveRefreshPolicyCore:
// the UI heartbeats while visible+interacting, and the interval shrinks
// with heartbeat recency — <5m ago: 2m, <1h: 5m, <4h: 15m, else 30m.
// REFRESH_MINUTES, if set, caps the interval (acts as a max).
//
// Env: PB_URL, REFRESH_MINUTES, CHROME_PROFILE_DIR (optional override).

import { PROVIDERS, NO_SESSION_PROVIDERS } from "./providers.mjs";
import { beginRound } from "./http.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8099";
const REFRESH_MINUTES = process.env.REFRESH_MINUTES
  ? Number(process.env.REFRESH_MINUTES)
  : null;

// Adaptive refresh, ported from AdaptiveRefreshPolicyCore.swift: the
// native app's "menu opened recently" becomes "UI heartbeat recently".
const MIN_INTERVAL_MS = 2 * 60_000;

async function nextIntervalMs(results) {
  let lastActiveAt = null;
  try {
    const res = await fetch(`${PB_URL}/api/codexbar/heartbeat`);
    if (res.ok) lastActiveAt = (await res.json()).lastActiveAt;
  } catch (_) {}
  const age = lastActiveAt
    ? Date.now() - new Date(lastActiveAt).getTime()
    : Infinity;
  let ms =
    age < 5 * 60_000
      ? 2 * 60_000
      : age < 3600_000
        ? 5 * 60_000
        : age < 4 * 3600_000
          ? 15 * 60_000
          : 30 * 60_000;
  // Wake ~30s after the nearest window reset so the UI picks up fresh
  // quota right when it resets instead of up to a full interval late.
  let nextReset = Infinity;
  for (const r of results || []) {
    for (const w of r.windows || []) {
      if (!w.resetAt) continue;
      const t = new Date(w.resetAt).getTime();
      if (t > Date.now() && t < nextReset) nextReset = t;
    }
  }
  if (nextReset < Infinity) {
    ms = Math.min(ms, Math.max(MIN_INTERVAL_MS, nextReset + 30_000 - Date.now()));
  }
  if (REFRESH_MINUTES != null) ms = Math.min(ms, REFRESH_MINUTES * 60_000);
  return Math.max(MIN_INTERVAL_MS, ms);
}

async function postSnapshot(providerId, snapshot) {
  const res = await fetch(`${PB_URL}/api/codexbar/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: providerId, ...snapshot }),
  });
  if (!res.ok) throw new Error(`PB snapshot POST ${res.status}: ${await res.text()}`);
}

// One round: providers run strictly serially (never parallel), per
// NO-BRIDGE-DESIGN.md §4.3. beginRound() clears the consecutive-block
// cooldowns so a provider blocked last round gets a fresh try this round.
async function fetchAll() {
  beginRound();
  const results = [];
  for (const p of PROVIDERS) {
    let snap;
    try {
      snap = await p.fetch();
    } catch (e) {
      snap = { status: e.code === "no-session" ? "no-session" : "error", error: e.message };
    }
    try {
      await postSnapshot(p.id, snap);
    } catch (e) {
      console.error(`[${p.id}] snapshot POST failed: ${e.message}`);
    }
    results.push({ id: p.id, ...snap });
    console.log(`[${p.id}] ${snap.status}${snap.error ? ` — ${snap.error}` : ""}`);
  }
  for (const p of NO_SESSION_PROVIDERS) {
    try {
      await postSnapshot(p.id, { status: "no-session" });
    } catch (e) {
      console.error(`[${p.id}] snapshot POST failed: ${e.message}`);
    }
    results.push({ id: p.id, status: "no-session" });
  }
  return results;
}

const once = process.argv.includes("--once");
if (once) {
  await fetchAll();
} else {
  console.log(
    `codexbar fetcher: adaptive (2m/5m/15m/30m by UI heartbeat${
      REFRESH_MINUTES != null ? `, cap ${REFRESH_MINUTES}m` : ""
    }) → ${PB_URL} (direct HTTP, no browser bridge)`,
  );
  for (;;) {
    const results = await fetchAll().catch((e) => {
      console.error(`fetch cycle failed: ${e.message}`);
      return [];
    });
    const ms = await nextIntervalMs(results);
    console.log(`next fetch in ${Math.round(ms / 60_000)}m`);
    await new Promise((r) => setTimeout(r, ms));
  }
}
