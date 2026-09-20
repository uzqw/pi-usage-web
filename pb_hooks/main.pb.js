/// <reference path="../pb_data/types.d.ts" />

// CodexBar web backend: stores provider usage snapshots pushed by the
// Node fetcher (web/fetcher/fetch.mjs, which drives the opencli browser
// bridge) and serves them to the React UI.
//
// Snapshot shape stored in `usage_snapshots.data`:
//   { status: "ok"|"no-session"|"error", plan?, email?, windows?: [{label,
//   usedPercent, used?, limit?, resetAt?}], credits?, error? }
//
// Note: in this PB version's goja JSVM, top-level declarations are not
// reliably visible inside hook callbacks — everything is inlined per route.
// Collection bootstrap is lazy (first-hit): onBootstrap runs before the
// collections table is guaranteed loaded and findCollectionByNameOrId
// panics there.

routerAdd("GET", "/api/codexbar/health", (e) => {
  return e.json(200, { ok: true, app: "codexbar-web" });
});

routerAdd("GET", "/api/codexbar/providers", (e) => {
  const names = {
    codex: "Codex",
    kimi: "Kimi",
    ollama: "Ollama",
    commandcode: "CommandCode",
    grok: "Grok",
    cursor: "Cursor",
    opencode: "OpenCode",
    manus: "Manus",
    devin: "Devin",
    xai: "xAI",
    openai: "OpenAI",
  };
  let records = [];
  try {
    records = $app.findRecordsByFilter(
      "usage_snapshots",
      "id != ''",
      "-fetchedAt",
      500,
      0,
    );
  } catch (_) {
    // collection not created yet — all providers report pending
  }
  const latest = {};
  for (const r of records) {
    const p = r.getString("provider");
    if (!latest[p]) {
      const data = JSON.parse(r.getString("data") || "{}");
      data.status = r.getString("status");
      data.fetchedAt = r.getString("fetchedAt");
      latest[p] = data;
    }
  }
  // Any provider seen in snapshots but missing from `names` still shows up
  // (fetcher may add providers before this map is updated).
  for (const id of Object.keys(latest)) {
    if (!names[id]) {
      names[id] = id.charAt(0).toUpperCase() + id.slice(1);
    }
  }
  const providers = Object.keys(names).map((id) => ({
    id,
    name: names[id],
    ...(latest[id] || { status: "pending" }),
  }));
  return e.json(200, { providers });
});

// Last-24h snapshot history for one provider, oldest first. Used by the
// card sparklines.
routerAdd("GET", "/api/codexbar/history", (e) => {
  const provider = String(e.requestInfo().query.provider || "");
  if (!provider) {
    return e.json(400, { error: "provider required" });
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000)
    .toISOString()
    .replace("T", " ");
  let records = [];
  try {
    records = $app.findRecordsByFilter(
      "usage_snapshots",
      "provider = {:provider} && fetchedAt >= {:since}",
      "fetchedAt",
      500,
      0,
      { provider, since },
    );
  } catch (_) {
    // collection not created yet
  }
  const points = records.map((r) => {
    const data = JSON.parse(r.getString("data") || "{}");
    return {
      fetchedAt: r.getString("fetchedAt"),
      status: r.getString("status"),
      windows: (data.windows || []).map((w) => ({
        label: w.label,
        usedPercent: w.usedPercent,
      })),
    };
  });
  return e.json(200, { provider, points });
});

// Kick off one fetcher round in the background and return immediately — a
// full sweep takes tens of seconds. Spawns via `nohup ... &` so the goja
// handler doesn't block and no zombie child is left behind; pgrep guards
// against overlapping runs from repeat clicks.
routerAdd("POST", "/api/codexbar/refresh", (e) => {
  const hooksDir =
    typeof __hooks === "string" ? __hooks : $os.getwd() + "/pb_hooks";
  const fetcher = hooksDir + "/../fetcher/fetch.mjs";
  // Always post back to loopback: the UI may be reached via 0.0.0.0 or a
  // LAN IP, and e.request.host would send the fetcher somewhere dead.
  const pbUrl = "http://127.0.0.1:8099";
  // Guard on the node cmdline only — matching 'fetch.mjs --once' plainly
  // also matches this wrapper script itself, so nothing ever spawned.
  let already = false;
  try {
    $os.cmd("pgrep", "-f", "node .*fetch\\.mjs --once").run();
    already = true;
  } catch (_) {}
  if (!already) {
    const script =
      "PB_URL=" + pbUrl + " nohup node " + fetcher +
      " --once >>/tmp/codexbar-fetch.log 2>&1 &";
    try {
      $os.cmd("sh", "-c", script).run();
    } catch (err) {
      return e.json(500, { ok: false, error: String(err) });
    }
  }
  // started=false tells the UI a fetch is already in flight.
  return e.json(200, { ok: true, started: !already });
});

// Ingest endpoint for the fetcher. Local-only app; no auth.
routerAdd("POST", "/api/codexbar/snapshot", (e) => {
  const body = e.requestInfo().body;
  const provider = String(body.provider || "");
  const status = String(body.status || "");
  if (!provider || !status) {
    return e.json(400, { error: "provider and status required" });
  }
  let collection;
  try {
    collection = $app.findCollectionByNameOrId("usage_snapshots");
  } catch (_) {
    collection = new Collection({
      name: "usage_snapshots",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "provider", type: "text", required: true },
        { name: "status", type: "text", required: true },
        { name: "data", type: "json" },
        { name: "fetchedAt", type: "date", required: true },
      ],
      indexes: [
        "CREATE INDEX idx_snap_provider ON usage_snapshots (provider, fetchedAt)",
      ],
    });
    $app.save(collection);
  }
  // A transient fetch failure (opencli "HTTP -1") must not wipe the last good
  // reading. If this provider's previous snapshot was healthy and recent,
  // reuse its payload and store this one as `stale_error` so the UI keeps the
  // card and shows a "last fetch failed" note until the next success.
  const FALLBACK_MS = 2 * 3600 * 1000;
  const hasPayload = (d) =>
    !!((d.windows && d.windows.length) || d.credits);
  let prev = null;
  try {
    const found = $app.findRecordsByFilter(
      "usage_snapshots",
      "provider = {:provider}",
      "-fetchedAt",
      1,
      0,
      { provider },
    );
    if (found.length) prev = found[0];
  } catch (_) {
    // collection not created yet — nothing to fall back to
  }
  let fallback = null;
  if (status === "error" && prev) {
    const prevStatus = prev.getString("status");
    const prevAt = new Date(
      String(prev.getString("fetchedAt")).replace(" ", "T"),
    ).getTime();
    let prevData = {};
    try {
      prevData = JSON.parse(prev.getString("data") || "{}");
    } catch (_) {}
    if (
      (prevStatus === "ok" || prevStatus === "stale_error") &&
      prevAt > 0 &&
      Date.now() - prevAt < FALLBACK_MS &&
      hasPayload(prevData)
    ) {
      fallback = {
        plan: prevData.plan || null,
        email: prevData.email || null,
        windows: prevData.windows || null,
        credits: prevData.credits || null,
        lastOkAt: prevData.lastOkAt || prev.getString("fetchedAt"),
      };
    }
  }
  const record = new Record(collection);
  record.set("provider", provider);
  if (fallback) {
    record.set("status", "stale_error");
    record.set("data", {
      status: "stale_error",
      plan: fallback.plan,
      email: fallback.email,
      windows: fallback.windows,
      credits: fallback.credits,
      lastError: body.error || null,
      lastOkAt: fallback.lastOkAt,
    });
  } else {
    record.set("status", status);
    record.set("data", {
      status,
      plan: body.plan,
      email: body.email,
      windows: body.windows,
      credits: body.credits,
      error: body.error,
    });
  }
  record.set("fetchedAt", new Date().toISOString());
  $app.save(record);
  return e.json(200, { ok: true, status: fallback ? "stale_error" : status });
});

// Heartbeat: the UI POSTs here while the page is visible and the user is
// interacting; the fetcher GETs it to pick its next sleep (adaptive
// refresh — heartbeat recency stands in for the native menu-open recency).
// Stored in an `app_state` key/value collection because goja top-level
// vars aren't shared across route invocations. No auth: local-only app.
// POST accepts an optional `at` ISO timestamp to simulate older activity.
routerAdd("POST", "/api/codexbar/heartbeat", (e) => {
  let collection;
  try {
    collection = $app.findCollectionByNameOrId("app_state");
  } catch (_) {
    collection = new Collection({
      name: "app_state",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "key", type: "text", required: true },
        { name: "value", type: "text" },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_state_key ON app_state (key)"],
    });
    $app.save(collection);
  }
  const at = String(e.requestInfo().body.at || new Date().toISOString());
  let record = null;
  try {
    const found = $app.findRecordsByFilter(
      "app_state",
      "key = {:k}",
      "",
      1,
      0,
      { k: "lastActiveAt" },
    );
    if (found.length) record = found[0];
  } catch (_) {}
  if (!record) record = new Record(collection);
  record.set("key", "lastActiveAt");
  record.set("value", at);
  $app.save(record);
  return e.json(200, { ok: true, lastActiveAt: at });
});

routerAdd("GET", "/api/codexbar/heartbeat", (e) => {
  let lastActiveAt = null;
  try {
    const found = $app.findRecordsByFilter(
      "app_state",
      "key = {:k}",
      "",
      1,
      0,
      { k: "lastActiveAt" },
    );
    if (found.length) lastActiveAt = found[0].getString("value");
  } catch (_) {
    // collection not created yet — no heartbeat ever recorded
  }
  return e.json(200, { lastActiveAt });
});
