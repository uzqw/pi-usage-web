#!/usr/bin/env node
// Machine metrics reporter — Netdata 思想的瘦身版：只采 温度/CPU/内存/网络/显卡，
// 零依赖，直读 /proc、/sys 和 nvidia-smi，每个周期 POST 一条快照到 pi-usage-web。
// 后端 /api/codexbar/machine + GET /api/codexbar/machines，UI 渲染成 Machines 卡片墙。
//
// Env: CODEXBAR_URL                    (default http://10.0.0.1:8099)
//      MACHINE_REPORT_ID               (default os.hostname())
//      MACHINE_REPORT_INTERVAL_MINUTES (default 1)
// `--once`: 采一轮即退出（给 cron / systemd timer 用）；缺省是常驻循环。

import { readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";

const PB_URL = (process.env.CODEXBAR_URL || "http://10.0.0.1:8099").replace(/\/+$/, "");
const HOST = process.env.MACHINE_REPORT_ID || os.hostname();
const INTERVAL_MS =
  Number(process.env.MACHINE_REPORT_INTERVAL_MINUTES || 1) * 60_000;
const ONCE = process.argv.includes("--once");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// jiffies 计数；busy = total - idle - iowait
function readCpu() {
  const cols = readFileSync("/proc/stat", "utf8")
    .split("\n")[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = cols;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, idle: idle + iowait };
}

function readNet() {
  let rx = 0;
  let tx = 0;
  for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m || m[1].trim() === "lo") continue;
    const cols = m[2].trim().split(/\s+/).map(Number);
    rx += cols[0];
    tx += cols[8];
  }
  return { rx, tx };
}

function readMem() {
  const info = {};
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) info[m[1]] = Number(m[2]);
  }
  const totalMb = Math.round((info.MemTotal || 0) / 1024);
  const availMb = Math.round((info.MemAvailable || 0) / 1024);
  return {
    usedPercent: totalMb ? +(((totalMb - availMb) / totalMb) * 100).toFixed(1) : null,
    usedMb: totalMb - availMb,
    totalMb,
  };
}

// 温度：首选 hwmon（lm-sensors 的数据源）——CPU(k10temp/coretemp)、NVMe、
// 内存条(spd5118) 都在这套接口下；没有 hwmon 的机器（很多 VM）退回
// thermal_zone。过滤常量垃圾 acpitz 和逐核 Core N（详情用 sensors 看）。
function readTemps() {
  const out = [];
  let hwmonDirs = [];
  try {
    hwmonDirs = readdirSync("/sys/class/hwmon");
  } catch {}
  for (const h of hwmonDirs) {
    if (!h.startsWith("hwmon")) continue;
    const base = `/sys/class/hwmon/${h}`;
    let dev;
    try {
      dev = readFileSync(`${base}/name`, "utf8").trim();
    } catch {
      continue;
    }
    if (dev === "acpitz") continue;
    let files = [];
    try {
      files = readdirSync(base);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^temp\d+_input$/.test(f)) continue;
      try {
        const milli = Number(readFileSync(`${base}/${f}`, "utf8").trim());
        if (!Number.isFinite(milli) || milli <= 0) continue;
        let label = f.replace(/_input$/, "");
        try {
          label = readFileSync(`${base}/${label}_label`, "utf8").trim();
        } catch {}
        if (/^Core \d+$/.test(label)) continue;
        out.push({ label: `${dev} ${label}`, celsius: +(milli / 1000).toFixed(1) });
      } catch {
        // 单个传感器读失败 —— 跳过
      }
    }
  }
  // thermal_zone 兜底（部分 VM 只有这个）
  if (!out.length) {
    let zones = [];
    try {
      zones = readdirSync("/sys/class/thermal").filter((d) =>
        d.startsWith("thermal_zone"),
      );
    } catch {
      return [];
    }
    for (const z of zones) {
      try {
        const label = readFileSync(`/sys/class/thermal/${z}/type`, "utf8").trim();
        const milli = Number(readFileSync(`/sys/class/thermal/${z}/temp`, "utf8").trim());
        if (Number.isFinite(milli) && milli > 0)
          out.push({ label, celsius: +(milli / 1000).toFixed(1) });
      } catch {
        // zone 无 type/temp —— 跳过
      }
    }
  }
  // 同名传感器（双 NVMe、多条内存）加 #2 后缀——标签是前端曲线匹配的 key，
  // 必须稳定唯一（hwmon 枚举顺序跨重启稳定）。
  const counts = {};
  for (const t of out) {
    const n = (counts[t.label] || 0) + 1;
    counts[t.label] = n;
    if (n > 1) t.label = `${t.label} #${n}`;
  }
  out.sort((a, b) => b.celsius - a.celsius);
  return out;
}

function readGpus() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve([]);
        const gpus = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name, util, memUsed, memTotal, temp] = line.split(",").map((s) => s.trim());
            return {
              name,
              utilPercent: Number(util),
              memUsedMb: Number(memUsed),
              memTotalMb: Number(memTotal),
              tempC: Number(temp),
            };
          });
        resolve(gpus);
      },
    );
  });
}

async function collect() {
  const cpu1 = readCpu();
  const net1 = readNet();
  const t1 = Date.now();
  await sleep(1000);
  const cpu2 = readCpu();
  const net2 = readNet();
  const secs = (Date.now() - t1) / 1000;

  const cpuPct =
    cpu2.total > cpu1.total
      ? +(
          ((cpu2.total - cpu1.total - (cpu2.idle - cpu1.idle)) /
            (cpu2.total - cpu1.total)) *
          100
        ).toFixed(1)
      : null;

  const data = {
    cpu: { usedPercent: cpuPct, cores: os.cpus().length },
    mem: readMem(),
    net: {
      rxBps: Math.max(0, Math.round((net2.rx - net1.rx) / secs)),
      txBps: Math.max(0, Math.round((net2.tx - net1.tx) / secs)),
    },
    temps: readTemps(),
    gpus: await readGpus(),
  };
  const res = await fetch(`${PB_URL}/api/codexbar/machine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: HOST, data }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
  console.log(`${new Date().toISOString()} ${HOST} cpu=${cpuPct}% mem=${data.mem.usedPercent}%`);
}

if (ONCE) {
  collect().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  const loop = async () => {
    for (;;) {
      try {
        await collect();
      } catch (e) {
        console.error(e.message);
      }
      await sleep(INTERVAL_MS);
    }
  };
  loop();
}
