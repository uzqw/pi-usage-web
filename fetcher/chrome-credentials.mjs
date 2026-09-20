// Read the user's logged-in Chrome credentials straight off disk, so the
// backend node process can issue its own HTTP requests instead of driving a
// browser tab through the opencli bridge.
//
//   import { getCookieHeader, getLocalStorage, listProfiles } from "./chrome-credentials.mjs";
//   const cookie = getCookieHeader("ollama.com");        // "aid=...; __Secure-session=..."
//   const ls = getLocalStorage("https://app.devin.ai");  // { auth1_session: '{"token":...}', ... }
//
// Linux only. Two on-disk stores are read:
//
//   cookies        ~/.config/google-chrome/<profile>/Cookies
//                  SQLite; `encrypted_value` is AES-128-CBC with a fixed
//                  16-space IV. Key = PBKDF2-SHA1(password, "saltysalt", 1,
//                  16). `password` comes from KWallet ("Chrome Safe Storage")
//                  when the cookie carries a `v11` prefix, or is the legacy
//                  hardcoded "peanuts" when it carries `v10`. The plaintext is
//                  SHA256(host_key) || value, which doubles as a key check.
//   localStorage   ~/.config/google-chrome/<profile>/Local Storage/leveldb/
//                  LevelDB (snappy-compressed blocks + write-ahead log),
//                  keyed `_<origin>\x00\x01<key>`, value prefixed with \x01.
//
// Both stores are read-only and safe while Chrome is running.

import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- profiles

const ROOTS = [
  process.env.CHROME_PROFILE_DIR,
  join(homedir(), ".config/google-chrome"),
  join(homedir(), ".config/chromium"),
  join(homedir(), ".config/google-chrome-beta"),
  join(homedir(), ".config/google-chrome-unstable"),
].filter((p) => p && existsSync(p));

function localState(root) {
  try {
    return JSON.parse(readFileSync(join(root, "Local State"), "utf8"));
  } catch {
    return {};
  }
}

/** Chrome profiles on this machine, most recently used first. */
export function listProfiles() {
  const out = [];
  for (const root of ROOTS) {
    const state = localState(root);
    const names = Object.keys(state.profile?.info_cache || {});
    const lastUsed = state.profile?.last_used;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name))
      .map((e) => e.name);
    for (const d of new Set([...dirs, ...names])) {
      const path = join(root, d);
      if (!existsSync(join(path, "Cookies")) && !existsSync(join(path, "Preferences"))) continue;
      out.push({
        dir: d,
        name: state.profile?.info_cache?.[d]?.name || d,
        root,
        path,
        lastUsed: d === lastUsed,
        activeTime: Number(state.profile?.info_cache?.[d]?.active_time) || 0,
      });
    }
  }
  return out.sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || b.activeTime - a.activeTime);
}

function pickProfile(profile, need) {
  const all = listProfiles();
  if (!all.length) throw new Error("no Chrome profile found (looked in " + ROOTS.join(", ") + ")");
  if (profile) {
    const found = all.find((p) => p.dir === profile || p.path === profile || p.name === profile);
    if (!found) throw new Error(`Chrome profile ${profile} not found`);
    return found;
  }
  for (const p of all) {
    if (!need || existsSync(need(p))) return p;
  }
  return all[0];
}

// ------------------------------------------------------------------ crypto

const SALT = "saltysalt";
const IV = Buffer.alloc(16, 0x20); // Chrome's fixed IV: 16 spaces

function deriveKey(password) {
  return pbkdf2Sync(password, SALT, 1, 16, "sha1");
}

let passwordsCache;
/** Candidate cookie passwords, most likely first. */
function passwords() {
  if (passwordsCache) return passwordsCache;
  const found = [];
  try {
    const out = execFileSync(
      "kwallet-query",
      ["-f", "Chrome Keys", "-r", "Chrome Safe Storage", "kdewallet"],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (out) found.push(out);
  } catch {}
  try {
    const out = execFileSync("secret-tool", ["lookup", "application", "chrome"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out && !found.includes(out)) found.push(out);
  } catch {}
  found.push("peanuts"); // legacy fallback key Chrome uses with no keyring
  passwordsCache = found;
  return found;
}

/**
 * Decrypt one `cookies.encrypted_value`.
 * v10 -> legacy password, v11 -> keyring password, but we verify with the
 * SHA256(host_key) prefix rather than trusting the version byte.
 */
function decryptCookie(enc, hostKey) {
  const buf = Buffer.from(enc);
  if (buf.length < 3) return null;
  const version = buf.subarray(0, 3).toString("latin1");
  if (version !== "v10" && version !== "v11") return buf.toString("utf8"); // plaintext row
  const body = buf.subarray(3);
  const digest = createHash("sha256").update(hostKey).digest();
  const ordered = version === "v11" ? passwords() : [...passwords()].reverse();
  for (const password of ordered) {
    let out;
    try {
      const d = createDecipheriv("aes-128-cbc", deriveKey(password), IV);
      d.setAutoPadding(false);
      out = Buffer.concat([d.update(body), d.final()]);
    } catch {
      continue;
    }
    const pad = out[out.length - 1];
    if (!(pad >= 1 && pad <= 16)) continue;
    out = out.subarray(0, out.length - pad);
    if (out.length < 32 || !out.subarray(0, 32).equals(digest)) continue;
    return out.subarray(32).toString("utf8");
  }
  return null;
}

// ------------------------------------------------------------------ cookies

function openSqlite(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    // Chrome holding the DB open (or a WAL rollback) can make read-only open
    // fail; a copy is just as good for a snapshot read.
    const dir = mkdtempSync(join(tmpdir(), "chrome-cookies-"));
    const copy = join(dir, "Cookies");
    copyFileSync(file, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
    }
    return new DatabaseSync(copy, { readOnly: true });
  }
}

function hostMatches(host, hostKey) {
  const hk = hostKey.replace(/^\./, "").toLowerCase();
  return host === hk || host.endsWith(`.${hk}`);
}

/**
 * Cookie header for a domain or URL, e.g. `getCookieHeader("chatgpt.com")`.
 * `{ profile }` pins a Chrome profile dir/name; default is the profile that
 * has cookies for the host, preferring the most recently used one.
 */
export function getCookieHeader(domainOrUrl, { profile, path } = {}) {
  const url = domainOrUrl.includes("://") ? new URL(domainOrUrl) : null;
  const host = (url ? url.hostname : domainOrUrl).toLowerCase();
  const secure = url ? url.protocol === "https:" : true;
  const reqPath = url?.pathname || path;

  const candidates = profile
    ? [pickProfile(profile)]
    : (() => {
        const cookieFile = (p) => join(p.path, "Cookies");
        const hits = listProfiles().filter((p) => {
          if (!existsSync(cookieFile(p))) return false;
          let db;
          try {
            db = new DatabaseSync(cookieFile(p), { readOnly: true });
            const hosts = db.prepare("select distinct host_key from cookies").all();
            return hosts.some((r) => hostMatches(host, r.host_key));
          } catch {
            return false;
          } finally {
            db?.close();
          }
        });
        return [hits[0] || pickProfile(null)];
      })();

  const profileDir = candidates[0];
  const file = join(profileDir.path, "Cookies");
  if (!existsSync(file)) {
    throw new Error(`no Cookies database in Chrome profile ${profileDir.path}`);
  }
  const db = openSqlite(file);
  let rows;
  try {
    rows = db
      .prepare(
        "select host_key, name, value, encrypted_value, is_secure, path, " +
          "cast(expires_utc as text) as expires_utc from cookies order by length(path) desc",
      )
      .all();
  } finally {
    db.close();
  }

  const now = BigInt(Date.now() + 11644473600000) * 1000n; // Unix ms -> WebKit µs
  const parts = [];
  const seen = new Set();
  for (const r of rows) {
    if (!hostMatches(host, r.host_key)) continue;
    if (r.is_secure && !secure) continue;
    if (reqPath && !pathMatches(reqPath, r.path)) continue;
    const expires = BigInt(r.expires_utc || "0");
    if (expires !== 0n && expires < now) continue; // session cookies have 0
    const value = r.value || decryptCookie(r.encrypted_value, r.host_key);
    if (value == null) continue;
    if (seen.has(r.name)) continue; // more specific path wins (rows are sorted)
    seen.add(r.name);
    parts.push(`${r.name}=${value}`);
  }
  return parts.join("; ");
}

function pathMatches(reqPath, cookiePath) {
  const p = cookiePath || "/";
  if (reqPath === p) return true;
  if (!reqPath.startsWith(p)) return false;
  return p.endsWith("/") || reqPath[p.length] === "/";
}

// ------------------------------------------------------------------ leveldb

/** Raw snappy block decoder (literals + back-references). */
function snappyDecode(src) {
  let p = 0, shift = 0, ulen = 0, x;
  do {
    x = src[p++];
    ulen += (x & 0x7f) * 2 ** shift;
    shift += 7;
  } while (x & 0x80);
  const out = Buffer.alloc(ulen);
  let o = 0;
  while (o < ulen && p < src.length) {
    const tag = src[p++], kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len < 60) len += 1;
      else {
        const n = len - 59;
        len = 0;
        for (let i = 0; i < n; i++) len += src[p++] * 2 ** (8 * i);
        len += 1;
      }
      src.copy(out, o, p, p + len);
      p += len;
      o += len;
    } else {
      let len, off;
      if (kind === 1) {
        len = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | src[p++];
      } else if (kind === 2) {
        len = (tag >> 2) + 1;
        off = src[p] | (src[p + 1] << 8);
        p += 2;
      } else {
        len = (tag >> 2) + 1;
        off = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24);
        p += 4;
      }
      for (let i = 0; i < len && o < ulen; i++, o++) out[o] = out[o - off];
    }
  }
  return out.subarray(0, o);
}

function readVarint(buf, offset) {
  let value = 0, shift = 0, x;
  do {
    x = buf[offset++];
    value += (x & 0x7f) * 2 ** shift;
    shift += 7;
  } while (x & 0x80);
  return [value, offset];
}

function readBlock(buf, offset, size) {
  const raw = buf[offset + size] === 1 ? snappyDecode(buf.subarray(offset, offset + size)) : buf.subarray(offset, offset + size);
  const restarts = raw.readUInt32LE(raw.length - 4);
  const end = raw.length - 4 - restarts * 4;
  const entries = [];
  let p = 0, prev = Buffer.alloc(0);
  while (p < end) {
    let shared, nshared, vlen;
    [shared, p] = readVarint(raw, p);
    [nshared, p] = readVarint(raw, p);
    [vlen, p] = readVarint(raw, p);
    const key = Buffer.concat([prev.subarray(0, shared), raw.subarray(p, p + nshared)]);
    p += nshared;
    const value = raw.subarray(p, p + vlen);
    p += vlen;
    prev = key;
    entries.push([key, value]);
  }
  return entries;
}

/** LevelDB `.ldb` table: block-level entries carry an 8-byte internal-key suffix. */
function ldbEntries(buf) {
  const footer = buf.subarray(buf.length - 48);
  let p = 0, metaOff, metaSize, indexOff, indexSize;
  [metaOff, p] = readVarint(footer, p);
  [metaSize, p] = readVarint(footer, p);
  [indexOff, p] = readVarint(footer, p);
  [indexSize, p] = readVarint(footer, p);
  const out = [];
  for (const [, handle] of readBlock(buf, indexOff, indexSize)) {
    let q = 0, blockOff, blockSize;
    [blockOff, q] = readVarint(handle, q);
    [blockSize, q] = readVarint(handle, q);
    for (const [key, value] of readBlock(buf, blockOff, blockSize)) {
      out.push([key.subarray(0, Math.max(0, key.length - 8)), value]);
    }
  }
  return out;
}

/** LevelDB write-ahead log: full keys, no internal-key suffix. */
function logEntries(buf) {
  const out = [];
  let p = 0;
  while (p + 7 <= buf.length) {
    const len = buf.readUInt16LE(p + 4);
    const type = buf[p + 6];
    if (type === 0 || p + 7 + len > buf.length) break;
    const batch = buf.subarray(p + 7, p + 7 + len);
    p += 7 + len;
    if (p % 32768 > 32768 - 7) p += 32768 - (p % 32768); // block trailer padding
    if (type !== 1) continue; // fragmented records: skip, the .ldb has them
    const count = batch.readUInt32LE(8);
    let q = 12;
    for (let i = 0; i < count && q < batch.length; i++) {
      const tag = batch[q++];
      let klen, vlen;
      [klen, q] = readVarint(batch, q);
      const key = batch.subarray(q, q + klen);
      q += klen;
      let value = Buffer.alloc(0);
      if (tag === 1) {
        [vlen, q] = readVarint(batch, q);
        value = batch.subarray(q, q + vlen);
        q += vlen;
      }
      out.push([key, value]);
    }
  }
  return out;
}

/**
 * localStorage for an origin as a plain object, e.g.
 * `getLocalStorage("https://app.devin.ai")`. `{ profile }` as above; without
 * it, the profiles are tried most-recently-used first and the first one that
 * actually has this origin wins.
 */
export function getLocalStorage(origin, { profile, raw = false } = {}) {
  const base = origin.replace(/\/+$/, "");
  const prefix = Buffer.from(`_${base}\x00\x01`, "latin1");

  const candidates = profile
    ? [pickProfile(profile)]
    : listProfiles().filter((p) => existsSync(join(p.path, "Local Storage/leveldb")));

  for (const candidate of candidates) {
    const dir = join(candidate.path, "Local Storage/leveldb");
    if (!existsSync(dir)) continue;
    const store = readLevelDb(dir, prefix, raw);
    if (store.size) return raw ? store : Object.fromEntries(store);
  }
  if (profile) throw new Error(`no ${base} localStorage in Chrome profile ${profile}`);
  return raw ? new Map() : {};
}

function readLevelDb(dir, prefix, raw) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ldb") || f.endsWith(".log"))
    .sort((a, b) => (a.endsWith(".ldb") ? 0 : 1) - (b.endsWith(".ldb") ? 0 : 1) || a.localeCompare(b));

  const store = new Map();
  for (const f of files) {
    const buf = readFileSync(join(dir, f));
    if (!buf.length) continue;
    let entries;
    try {
      entries = f.endsWith(".ldb") ? ldbEntries(buf) : logEntries(buf);
    } catch {
      continue; // a torn/compacted file should not sink the read
    }
    for (const [key, value] of entries) {
      if (!key.subarray(0, prefix.length).equals(prefix)) continue;
      const name = key.subarray(prefix.length).toString("utf8");
      let text = value;
      if (text[0] === 0x01) text = text.subarray(1); // Chromium value type byte
      store.set(name, raw ? text : text.toString("utf8"));
    }
  }
  return store;
}

// ---------------------------------------------------------------- user agent

/** Browser UA matching the installed Chrome, for requests that need one. */
export function chromeUserAgent() {
  for (const root of ROOTS) {
    try {
      const version = readFileSync(join(root, "Last Version"), "utf8").trim();
      const major = version.split(".")[0];
      if (major) {
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
      }
    } catch {}
  }
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
}
