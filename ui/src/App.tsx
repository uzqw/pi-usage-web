import { useEffect, useRef, useState } from "react";
import "./App.css";

interface Window {
  label: string;
  usedPercent?: number | null;
  used?: number;
  limit?: number;
  resetAt?: string | null;
}

interface Provider {
  id: string;
  name: string;
  status: string;
  plan?: string | null;
  email?: string | null;
  windows?: Window[];
  credits?: { balance?: number; usedRatio?: number; unlimited?: boolean } | null;
  error?: string;
  lastError?: string;
  lastOkAt?: string;
  fetchedAt?: string;
}

interface HistoryPoint {
  fetchedAt: string;
  status: string;
  windows?: { label: string; usedPercent?: number | null }[];
}

// Provider brand accent colors.
const ACCENTS: Record<string, string> = {
  codex: "#49A3B0",
  kimi: "#FE603C",
  ollama: "#888888",
  commandcode: "#A04DFD",
  grok: "#10A37F",
  cursor: "#00BFA5",
  opencode: "#3B82F6",
  manus: "#0099FF",
  devin: "#46B482",
  xai: "#8E8E93",
  openai: "#0F826E",
};

function accent(id: string): string {
  return ACCENTS[id] ?? "#6f8cff";
}

function resetIn(resetAt?: string | null): string | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Fetcher refreshes every REFRESH_MINUTES (default 15); flag data older
// than 2 cycles as stale.
const STALE_MS = 30 * 60_000;

function isStale(fetchedAt?: string): boolean {
  return !!fetchedAt && Date.now() - new Date(fetchedAt).getTime() > STALE_MS;
}

function barClass(pct: number): string {
  if (pct > 80) return "bar-fill high";
  if (pct >= 50) return "bar-fill mid";
  return "bar-fill low";
}

// Window usage text: prefer the percent; fall back to whichever of
// used/limit exists so a null limit never renders as "0/null".
function usageText(w: Window): string {
  if (w.usedPercent != null) return `${w.usedPercent}% used`;
  const used = w.used ?? 0;
  return w.limit != null ? `${used}/${w.limit}` : `${used}`;
}

// Dollar-ish credit balance (opencode "pay as you go", codex credits).
function fmtBalance(n: number): string {
  return `$${n.toFixed(2)}`;
}

// status ok but nothing worth showing: every window is zero/empty
// (used:0 with no limit/percent, like opencode's empty "Monthly spend")
// and credits carry no balance/usedRatio. Hidden like no-session.
function hasData(p: Provider): boolean {
  const win = (p.windows || []).some(
    (w) => w.usedPercent != null || w.limit != null || !!w.used,
  );
  const c = p.credits;
  const cred =
    c != null && (!!c.balance || c.usedRatio != null || !!c.unlimited);
  return win || cred;
}

// Cards that actually render: skip no-session and ok-but-empty. A failed
// fetch (error / stale_error) still renders when the backend kept the last
// good windows, so a transient bridge miss doesn't make the card disappear.
function isVisible(p: Provider): boolean {
  if (p.status === "no-session") return false;
  if (p.status === "error" || p.status === "stale_error" || p.status === "ok") {
    return hasData(p);
  }
  return true; // pending
}

// Plain-SVG sparkline of the first window's usedPercent over the last 24h.
// Polyline points are scaled into a fixed viewBox; stroke uses the accent.
function Sparkline({ points, color }: { points: HistoryPoint[]; color: string }) {
  const values = points
    .map((p) => p.windows?.[0]?.usedPercent)
    .filter((v): v is number => v != null);
  if (values.length < 2) return null;
  const W = 100;
  const H = 24;
  const max = Math.max(100, ...values);
  const step = W / (values.length - 1);
  const coords = values
    .map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline
        points={coords}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Avatar({ p }: { p: Provider }) {
  return (
    <span className="avatar" style={{ background: accent(p.id) }}>
      {p.name.charAt(0).toUpperCase()}
    </span>
  );
}

const FLASH_GREEN = "#4cc38a";

function Card({
  p,
  history,
  flash,
}: {
  p: Provider;
  history?: HistoryPoint[];
  flash?: boolean;
}) {
  const color = accent(p.id);
  // Inline borderColor wins over the accent border-left, so the flash
  // greens the whole border; .flash-ok supplies the 2px width.
  const style = flash
    ? { borderColor: FLASH_GREEN }
    : { borderLeftColor: color };
  const flashCls = flash ? " flash-ok" : "";
  // Failed fetch, but the backend may have kept the last good payload.
  const degraded = p.status === "stale_error" || p.status === "error";
  if (!hasData(p)) {
    if (degraded) {
      return (
        <div className={`card status-error${flashCls}`} style={style}>
          <h2>
            <Avatar p={p} />
            {p.name}
          </h2>
          <p className="error">{p.lastError || p.error || "fetch error"}</p>
        </div>
      );
    }
    return (
      <div className={`card status-pending${flashCls}`} style={style}>
        <h2>
          <Avatar p={p} />
          {p.name}
        </h2>
        <p>Awaiting first fetch…</p>
      </div>
    );
  }
  // Data card: a healthy snapshot, or a failed fetch whose last good windows
  // were retained. `asOf` keeps the timestamp honest in the failed case.
  const asOf = degraded ? p.lastOkAt || p.fetchedAt : p.fetchedAt;
  return (
    <div className={`card status-ok${flashCls}`} style={style}>
      <h2>
        <Avatar p={p} />
        {p.name}
        {p.plan && <span className="plan">{p.plan}</span>}
      </h2>
      {(p.windows || []).map((w) => (
        <div key={w.label} className="window">
          <div className="window-head">
            <span>{w.label}</span>
            <span>{usageText(w)}</span>
          </div>
          {w.usedPercent != null && (
            <div className="bar">
              <div
                className={barClass(w.usedPercent)}
                style={{ width: `${Math.min(100, w.usedPercent)}%` }}
              />
            </div>
          )}
          {w.resetAt && (
            <small>
              <span className="resets-prefix">resets in </span>
              {resetIn(w.resetAt)}
            </small>
          )}
        </div>
      ))}
      {p.credits?.unlimited ? (
        <p className="credits">Credits: unlimited</p>
      ) : (
        p.credits?.balance != null && (
          <p className="credits">Credits: {fmtBalance(p.credits.balance)}</p>
        )
      )}
      {p.credits?.usedRatio != null && (
        <p className="credits">Subscription pool: {Math.round(p.credits.usedRatio * 100)}% used</p>
      )}
      {degraded && (
        <p className="error stale-note">
          {p.lastError || p.error || "fetch error"} — showing last good data
        </p>
      )}
      {history && <Sparkline points={history} color={color} />}
      {asOf && (
        <small className="fetched">
          fetched {relTime(asOf)}
          {isStale(asOf) && <span className="stale">stale</span>}
        </small>
      )}
    </div>
  );
}

function App() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clickedAtRef = useRef(0);
  const visibleIdsRef = useRef<Set<string>>(new Set());
  // Ids flashed green for 1s after their card's fetchedAt crosses the
  // click time. flashedRef dedupes across poll ticks; timers per id so
  // simultaneous completions fade independently.
  const [justRefreshed, setJustRefreshed] = useState<Set<string>>(new Set());
  const flashedRef = useRef<Set<string>>(new Set());
  const flashTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());

  const load = () =>
    fetch("/api/codexbar/providers")
      .then((r) => r.json())
      .then((d) => setProviders(d.providers))
      .catch((e) => setError(String(e)));

  // Poll only while the tab is visible; reload on return to foreground.
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Heartbeat for the fetcher's adaptive interval: POST while the page is
  // visible and the user interacts (click/keydown/scroll, throttled to
  // 5min). Stands in for the native app's "menu opened" recency.
  useEffect(() => {
    let lastBeat = 0;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastBeat < 5 * 60_000) return;
      lastBeat = now;
      fetch("/api/codexbar/heartbeat", { method: "POST" }).catch(() => {});
    };
    beat(); // page load counts as activity
    for (const ev of ["click", "keydown", "scroll"]) {
      window.addEventListener(ev, beat, { passive: true });
    }
    document.addEventListener("visibilitychange", beat);
    return () => {
      for (const ev of ["click", "keydown", "scroll"]) {
        window.removeEventListener(ev, beat);
      }
      document.removeEventListener("visibilitychange", beat);
    };
  }, []);

  // Load 24h history per provider once the provider list is known.
  useEffect(() => {
    for (const p of providers) {
      if (history[p.id] || p.status !== "ok") continue;
      fetch(`/api/codexbar/history?provider=${encodeURIComponent(p.id)}`)
        .then((r) => r.json())
        .then((d) =>
          setHistory((h) => (h[p.id] ? h : { ...h, [p.id]: d.points || [] })),
        )
        .catch(() => {});
    }
  }, [providers, history]);

  // Progress bar: count providers whose fetchedAt is newer than the click.
  // Poll every 2s until all update, the fetcher dies, or 90s elapse.
  const refresh = async () => {
    setRefreshing(true);
    setRefreshFailed(false);
    const visibleIds = providers.filter(isVisible).map((p) => p.id);
    visibleIdsRef.current = new Set(visibleIds);
    setProgress({ done: 0, total: visibleIds.length });
    const clickedAt = Date.now();
    clickedAtRef.current = clickedAt;
    for (const t of flashTimersRef.current.values()) clearTimeout(t);
    flashTimersRef.current.clear();
    flashedRef.current = new Set();
    setJustRefreshed(new Set());
    let res: Response;
    try {
      res = await fetch("/api/codexbar/refresh", { method: "POST" });
    } catch {
      setRefreshing(false);
      setRefreshFailed(true);
      return;
    }
    if (!res.ok) {
      setRefreshing(false);
      setRefreshFailed(true);
      return;
    }
    const deadline = Date.now() + 90_000;
    pollRef.current = setInterval(() => {
      fetch("/api/codexbar/providers")
        .then((r) => r.json())
        .then((d) => {
          const ps: Provider[] = d.providers;
          setProviders(ps);
          const fresh = (p: Provider) =>
            p.fetchedAt &&
            new Date(p.fetchedAt).getTime() >= clickedAtRef.current;
          const ids = visibleIdsRef.current;
          const done = ps.filter((p) => ids.has(p.id) && fresh(p)).length;
          // Flash each card the first poll where its fetch lands.
          const newlyDone = ps.filter(
            (p) => fresh(p) && !flashedRef.current.has(p.id),
          );
          if (newlyDone.length > 0) {
            for (const p of newlyDone) {
              flashedRef.current.add(p.id);
              const t = setTimeout(() => {
                flashTimersRef.current.delete(p.id);
                setJustRefreshed((s) => {
                  const n = new Set(s);
                  n.delete(p.id);
                  return n;
                });
              }, 1_000);
              flashTimersRef.current.set(p.id, t);
            }
            setJustRefreshed(
              (s) => new Set([...s, ...newlyDone.map((p) => p.id)]),
            );
          }
          setProgress({ done, total: ids.size });
          // Hidden providers refresh too but don't count; with zero visible
          // cards, end on any update (or the deadline).
          const finished =
            ids.size > 0 ? done >= ids.size : ps.some(fresh);
          if (finished || Date.now() > deadline) {
            if (pollRef.current) clearInterval(pollRef.current);
            setRefreshing(false);
          }
        })
        .catch(() => {});
    }, 2_000);
  };

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
      for (const t of flashTimersRef.current.values()) clearTimeout(t);
    },
    [],
  );

  return (
    <main className="grid">
      <div className="topbar">
        <h1>pi-usage-web</h1>
        <button
          className={`refresh${refreshing ? " busy" : ""}${refreshFailed ? " failed" : ""}`}
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing && (
            <span
              className="refresh-fill"
              style={{
                width: `${
                  progress.total > 0
                    ? Math.round((progress.done / progress.total) * 100)
                    : 0
                }%`,
              }}
            />
          )}
          <span className="refresh-label">
            {refreshFailed
              ? "Refresh failed"
              : refreshing
                ? progress.total > 0
                  ? `Refreshing… ${progress.done}/${progress.total}`
                  : "Refreshing…"
                : "Refresh"}
          </span>
        </button>
      </div>
      {error && <p className="error">Backend unreachable: {error}</p>}
      <div className="cards">
        {[...providers]
          .filter(isVisible)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((p) => (
            <Card
              key={p.id}
              p={p}
              history={history[p.id]}
              flash={justRefreshed.has(p.id)}
            />
          ))}
      </div>
      {(() => {
        const hidden = providers.filter((p) => !isVisible(p));
        if (hidden.length === 0) return null;
        return (
          <p className="hidden-note">
            hidden:{" "}
            {hidden.map((p) => `${p.id} (${p.status})`).join(", ")}
          </p>
        );
      })()}
    </main>
  );
}

export default App;
