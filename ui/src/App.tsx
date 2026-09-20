import { Fragment, useEffect, useRef, useState } from "react";
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
  models?: ModelRow[];
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

// Per-(provider,model) usage windows pushed by pi-report (pi@<host> cards).
// A missing window key means "no data in that window".
interface ModelUsage {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  msgs: number;
}

interface ModelRow {
  provider: string;
  model: string;
  today?: ModelUsage;
  d7?: ModelUsage;
  all?: ModelUsage;
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

// ---------------------------------------------------------------------------
// Model usage formatting. Token counts collapse to K/M/B; zero renders as a
// dim dash instead of "0" so "no cache writes yet" reads differently from
// "cache writes are free". Every cell keeps its exact value in `title`.
// ---------------------------------------------------------------------------

type WinKey = "today" | "d7" | "all";

const WINS: WinKey[] = ["today", "d7", "all"];
const WIN_LABEL: Record<WinKey, string> = {
  today: "Today",
  d7: "7d",
  all: "All",
};

function fmtTok(n: number): string {
  if (n === 0) return "–";
  if (n < 1e4) return n.toLocaleString("en-US");
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

// Cost is a list-price equivalent, never a bill.
const NO_PRICE = "无牌价条目，按$0计";

function fmtCost(c: number): string {
  return c === 0 ? "–" : `$${c.toFixed(2)}`;
}

const ZERO: ModelUsage = {
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  msgs: 0,
};

function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    msgs: a.msgs + b.msgs,
  };
}

// Unified token count: sum the four components, not totalTokens — devin-style
// providers leave cacheRead out of totalTokens while pi core includes it.
function total(u: ModelUsage): number {
  return u.in + u.out + u.cacheRead + u.cacheWrite;
}

function TokCell({ n }: { n: number }) {
  return (
    <td className={`num${n === 0 ? " zero" : ""}`} title={fmtInt(n)}>
      {fmtTok(n)}
    </td>
  );
}

function CostCell({ c }: { c: number }) {
  return (
    <td
      className={`num${c === 0 ? " zero" : ""}`}
      title={c === 0 ? NO_PRICE : `$${c.toFixed(2)}`}
    >
      {fmtCost(c)}
    </td>
  );
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

// pi@<host> card body: three-window totals plus the day's top model. Replaces
// the generic window rows, whose "Tokens today" number is a raw count that
// reads badly next to percent-based cards. Falls back to those rows when
// `models` is absent (older pi-report).
function PiStats({ p, onFocus }: { p: Provider; onFocus?: () => void }) {
  const models = p.models || [];
  const sums: Record<WinKey, ModelUsage> = {
    today: { ...ZERO },
    d7: { ...ZERO },
    all: { ...ZERO },
  };
  for (const m of models) {
    for (const w of WINS) {
      const u = m[w];
      if (u) sums[w] = addUsage(sums[w], u);
    }
  }
  const top = models
    .map((m) => ({ m, u: m.today }))
    .filter((x): x is { m: ModelRow; u: ModelUsage } => !!x.u && x.u.msgs > 0)
    .sort((a, b) => total(b.u) - total(a.u) || b.u.cost - a.u.cost)[0];
  return (
    <div className="pi-stats">
      <div className="pi-row">
        <span className="pi-label">Tokens</span>
        {WINS.map((w) => (
          <span key={w} className="pi-cell">
            <small>{WIN_LABEL[w]}</small>
            <b title={fmtInt(total(sums[w]))}>{fmtTok(total(sums[w]))}</b>
          </span>
        ))}
      </div>
      <div className="pi-row">
        <span className="pi-label">$ equiv</span>
        {WINS.map((w) => (
          <span key={w} className="pi-cell">
            <small>{WIN_LABEL[w]}</small>
            <b
              className={sums[w].cost === 0 ? "zero" : ""}
              title={sums[w].cost === 0 ? NO_PRICE : `$${sums[w].cost.toFixed(2)}`}
            >
              {fmtCost(sums[w].cost)}
            </b>
          </span>
        ))}
      </div>
      {top && (
        <p className="pi-top">
          top: <span className="mono">{top.m.provider}/{top.m.model}</span>{" "}
          {fmtTok(total(top.u))}
        </p>
      )}
      <button className="pi-models" onClick={onFocus}>
        ▸ {models.length} models
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model usage panel: full-width table above the card wall, aggregating every
// pi@<host> snapshot's models[] for one window. Row key is provider+model, so
// the same model name from two providers stays two rows.
// ---------------------------------------------------------------------------

interface AggRow {
  key: string;
  provider: string;
  model: string;
  u: ModelUsage; // current-window total across machines
  machines: number;
  per: { machine: string; u: ModelUsage }[];
}

type SortKey = "tok" | "in" | "out" | "cost";

const TOP_N = 15;

function ModelPanel({
  providers,
  machine,
  setMachine,
}: {
  providers: Provider[];
  machine: string | null;
  setMachine: (m: string | null) => void;
}) {
  const [win, setWin] = useState<WinKey>("today");
  const [sortBy, setSortBy] = useState<SortKey>("tok");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const pis = providers.filter(
    (p) => p.id.startsWith("pi@") && (p.models?.length ?? 0) > 0,
  );
  const machines = pis.map((p) => p.id).sort();
  const shown = machine ? pis.filter((p) => p.id === machine) : pis;

  const byKey = new Map<string, AggRow>();
  for (const p of shown) {
    for (const m of p.models || []) {
      const u = m[win];
      if (!u || u.msgs <= 0) continue;
      const key = `${m.provider}/${m.model}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          provider: m.provider,
          model: m.model,
          u: { ...ZERO },
          machines: 0,
          per: [],
        };
        byKey.set(key, row);
      }
      row.u = addUsage(row.u, u);
      row.machines++;
      row.per.push({ machine: p.id, u });
    }
  }
  const rows = [...byKey.values()];
  rows.sort((a, b) => {
    const tie = () => total(b.u) - total(a.u) || a.model.localeCompare(b.model);
    if (sortBy === "cost") return b.u.cost - a.u.cost || tie();
    if (sortBy === "in") return b.u.in - a.u.in || tie();
    if (sortBy === "out") return b.u.out - a.u.out || tie();
    return total(b.u) - total(a.u) || b.u.cost - a.u.cost || a.model.localeCompare(b.model);
  });

  const sum = rows.reduce((a, r) => addUsage(a, r.u), { ...ZERO });
  const grand = total(sum);
  const list = showAll ? rows : rows.slice(0, TOP_N);
  const rest = rows.slice(TOP_N);
  const others = rest.reduce((a, r) => addUsage(a, r.u), { ...ZERO });
  const noPrice = rows.filter((r) => r.u.cost === 0).length;
  const showCacheWrite = sum.cacheWrite !== 0;
  const cols = 9 + (showCacheWrite ? 1 : 0);

  if (pis.length === 0) return null;

  const shareOf = (u: ModelUsage) => (grand > 0 ? (total(u) / grand) * 100 : 0);
  const sortable = (k: SortKey, label: string) => (
    <th
      className={`num sortable${sortBy === k ? " on" : ""}`}
      onClick={() => setSortBy(k)}
      title="sort by this column"
    >
      {label}
    </th>
  );

  const cells = (u: ModelUsage) => (
    <>
      <TokCell n={u.in} />
      <TokCell n={u.out} />
      <TokCell n={u.cacheRead} />
      {showCacheWrite && <TokCell n={u.cacheWrite} />}
      <CostCell c={u.cost} />
      <td className="num msgs-col" title={fmtInt(u.msgs)}>
        {fmtInt(u.msgs)}
      </td>
    </>
  );

  return (
    <section className="modelpanel">
      <div className="modelpanel-head">
        <h2>Model usage</h2>
        <div className="seg" role="group" aria-label="window">
          {WINS.map((w) => (
            <button
              key={w}
              className={win === w ? "on" : ""}
              onClick={() => setWin(w)}
            >
              {WIN_LABEL[w]}
            </button>
          ))}
        </div>
        {machines.length > 1 && (
          <div className="machine-chips">
            <button
              className={machine === null ? "on" : ""}
              onClick={() => setMachine(null)}
            >
              All
            </button>
            {machines.map((m) => (
              <button
                key={m}
                className={machine === m ? "on" : ""}
                onClick={() => setMachine(m)}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <label className="showall">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          show all
        </label>
      </div>
      <div className="modeltable-wrap">
        <table className="modeltable">
          <thead>
            <tr>
              <th
                className={`num sortable${sortBy === "tok" ? " on" : ""}`}
                onClick={() => setSortBy("tok")}
                title="sort by total tokens"
              >
                #
              </th>
              <th>model</th>
              <th>provider</th>
              {sortable("in", "input")}
              {sortable("out", "output")}
              <th className="num">cacheRead</th>
              {showCacheWrite && <th className="num">cacheWrite</th>}
              {sortable("cost", "$ equiv")}
              <th className="num msgs-col">msgs</th>
              <th className="share-col">share</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const pct = shareOf(r.u);
              const canExpand = r.machines > 1;
              return (
                <Fragment key={r.key}>
                  <tr
                    className={`${canExpand ? "expandable" : ""}${
                      expanded === r.key ? " open" : ""
                    }`}
                    onClick={
                      canExpand
                        ? () =>
                            setExpanded(expanded === r.key ? null : r.key)
                        : undefined
                    }
                  >
                    <td className="num idx">{i + 1}</td>
                    <td className="model">
                      {canExpand && (
                        <span className="caret">
                          {expanded === r.key ? "▾" : "▸"}
                        </span>
                      )}
                      {r.model}
                      {canExpand && (
                        <span className="mchip">×{r.machines}机</span>
                      )}
                    </td>
                    <td className="muted">{r.provider}</td>
                    {cells(r.u)}
                    <td className="share-col">
                      <span className="share-bar">
                        <i style={{ width: `${Math.min(100, pct * 2.2)}%` }} />
                      </span>
                      <span className="share-num">{pct.toFixed(1)}%</span>
                    </td>
                  </tr>
                  {canExpand &&
                    expanded === r.key &&
                    r.per.map((s) => (
                      <tr key={`${r.key}/${s.machine}`} className="subrow">
                        <td />
                        <td className="model sub">{s.machine}</td>
                        <td />
                        {cells(s.u)}
                        <td />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            {!showAll && rest.length > 0 && (
              <tr className="othersrow">
                <td />
                <td className="model">others ({rest.length} models)</td>
                <td />
                {cells(others)}
                <td className="share-col">
                  <span className="share-bar">
                    <i
                      style={{
                        width: `${Math.min(100, shareOf(others) * 2.2)}%`,
                      }}
                    />
                  </span>
                  <span className="share-num">{shareOf(others).toFixed(1)}%</span>
                </td>
              </tr>
            )}
            {rows.length === 0 && (
              <tr>
                <td className="empty" colSpan={cols}>
                  no model data in this window
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="sumrow">
              <td />
              <td className="model">
                Σ {rows.length} models
                {!showAll && rest.length > 0 ? ` (top ${TOP_N})` : ""}
              </td>
              <td />
              {cells(sum)}
              <td className="share-col" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="footnote">
        $ equiv = 牌价折算估算，非实付；{noPrice} 个模型无牌价（按 $0 计）
      </p>
    </section>
  );
}

function Card({
  p,
  history,
  flash,
  onFocus,
}: {
  p: Provider;
  history?: HistoryPoint[];
  flash?: boolean;
  onFocus?: () => void;
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
      {p.models?.length ? (
        <PiStats p={p} onFocus={onFocus} />
      ) : (
        (p.windows || []).map((w) => (
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
        ))
      )}
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
  // Which pi@<host> the model panel is focused on (null = all machines).
  // Lifted out of ModelPanel so the pi card's "N models" button can drive it.
  const [machine, setMachine] = useState<string | null>(null);
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
      <ModelPanel
        providers={providers}
        machine={machine}
        setMachine={setMachine}
      />
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
              onFocus={() =>
                setMachine((m) => (m === p.id ? null : p.id))
              }
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
