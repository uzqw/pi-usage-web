#!/usr/bin/env node
// CodexBar web fetcher: direct HTTP fetches per provider (no browser bridge —
// credentials come from local auth files and the Chrome profile via
// chrome-credentials.mjs), then POSTs normalized snapshots to the PocketBase
// hook. Runs one round and exits.
//
//   node fetcher/fetch.mjs
//
// Scheduling lives in PocketBase (pb_hooks cronAdd): a 2m cron reads the
// UI heartbeat and the latest snapshot's fetchedAt, then spawns this
// script when the adaptive interval has elapsed.
//
// Env: PB_URL, CHROME_PROFILE_DIR (optional override).

import { PROVIDERS, NO_SESSION_PROVIDERS } from "./providers.mjs";
import { beginRound } from "./http.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8099";

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

await fetchAll();
