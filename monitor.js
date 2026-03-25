// monitor.js
// Monitor HTTP services, notify Discord on state changes, and persist JSON metrics.

const fs = require("node:fs/promises");
const path = require("node:path");
const { startStatusServer } = require("./status-server");

function parseDotEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

async function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  try {
    const content = await fs.readFile(envPath, "utf8");
    const parsed = parseDotEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[${new Date().toISOString()}] Failed to read .env: ${err.message}`);
    }
  }
}

const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const INTERVAL_MS = Number.parseInt(process.env.MONITOR_INTERVAL_MS || "120000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MONITOR_TIMEOUT_MS || "8000", 10);
const MAX_CONSECUTIVE_FAILURES = Number.parseInt(process.env.MONITOR_FAIL_THRESHOLD || "1", 10);
const HISTORY_LIMIT = Number.parseInt(process.env.MONITOR_HISTORY_LIMIT || "720", 10);
const ALERT_ON_STARTUP_DOWN =
  String(process.env.MONITOR_ALERT_ON_STARTUP_DOWN || "true").toLowerCase() === "true";

const DATA_DIR = process.env.MONITOR_DATA_DIR || path.join(__dirname, "data");
const STATUS_FILE = path.join(DATA_DIR, "status.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const LOCK_FILE = path.join(DATA_DIR, "monitor.lock");

const SERVICES = [
  { name: "Site principal", url: "https://mhemery.fr" },
  { name: "Sonora", url: "https://sonora.mhemery.fr/health" },
  { name: "Vaultwarden", url: "https://pass.enerzein.fr" },
  { name: "Amether - CLOUD", url: "https://cloud.mhemery.fr" },
];

const stateByUrl = new Map();
const historyByUrl = new Map();
const activeControllers = new Set();
let shouldStop = false;
let statusServer;
let lockAcquired = false;
let sleepTimer = null;
let sleepResolve = null;

function nowIso() {
  return new Date().toISOString();
}

function getErrorCode(err) {
  return err?.code || err?.cause?.code || err?.errno || null;
}

function initState(url) {
  if (!stateByUrl.has(url)) {
    stateByUrl.set(url, {
      status: "UNKNOWN",
      consecutiveFailures: 0,
      lastCode: null,
      lastError: null,
      lastErrorCode: null,
      downNotified: false,
      lastLatencyMs: null,
      lastCheckedAt: null,
    });
  }
  return stateByUrl.get(url);
}

function pushHistory(url, point) {
  if (!historyByUrl.has(url)) {
    historyByUrl.set(url, []);
  }

  const points = historyByUrl.get(url);
  points.push(point);

  if (points.length > HISTORY_LIMIT) {
    points.splice(0, points.length - HISTORY_LIMIT);
  }
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  try {
    const raw = await fs.readFile(LOCK_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const existingPid = Number.parseInt(String(parsed.pid || ""), 10);

    if (isPidAlive(existingPid)) {
      console.error(
        `[FATAL] monitor already running with PID ${existingPid}. Stop it before starting a new instance.`
      );
      process.exit(1);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[${nowIso()}] [lock] failed reading lock file: ${err.message}`);
    }
  }

  await fs.writeFile(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, startedAt: nowIso() }, null, 2),
    "utf8"
  );
  lockAcquired = true;
}

async function releaseLock() {
  if (!lockAcquired) {
    return;
  }

  try {
    await fs.rm(LOCK_FILE, { force: true });
  } catch (err) {
    console.warn(`[${nowIso()}] [lock] failed removing lock file: ${err.message}`);
  } finally {
    lockAcquired = false;
  }
}

async function loadHistoryFromDisk() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.services)) {
      return;
    }

    for (const service of parsed.services) {
      if (!service || !service.url || !Array.isArray(service.points)) {
        continue;
      }

      historyByUrl.set(service.url, service.points.slice(-HISTORY_LIMIT));
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[${nowIso()}] [data] failed to load history: ${err.message}`);
    }
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function persistJson() {
  const statusPayload = {
    updatedAt: nowIso(),
    intervalMs: INTERVAL_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    failThreshold: MAX_CONSECUTIVE_FAILURES,
    services: SERVICES.map((service) => {
      const s = initState(service.url);
      return {
        name: service.name,
        url: service.url,
        status: s.status,
        consecutiveFailures: s.consecutiveFailures,
        lastCode: s.lastCode,
        lastError: s.lastError,
        lastErrorCode: s.lastErrorCode,
        lastLatencyMs: s.lastLatencyMs,
        lastCheckedAt: s.lastCheckedAt,
      };
    }),
  };

  const historyPayload = {
    updatedAt: statusPayload.updatedAt,
    limitPerService: HISTORY_LIMIT,
    services: SERVICES.map((service) => ({
      name: service.name,
      url: service.url,
      points: historyByUrl.get(service.url) || [],
    })),
  };

  await Promise.all([writeJson(STATUS_FILE, statusPayload), writeJson(HISTORY_FILE, historyPayload)]);
}

async function postDiscordEmbed({ title, description, color }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    return;
  }

  try {
    const res = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description,
            color,
            timestamp: nowIso(),
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[${nowIso()}] [discord] webhook error ${res.status}: ${body.slice(0, 400)}`);
    }
  } catch (err) {
    console.error(`[${nowIso()}] [discord] failed to send alert: ${err.message}`);
  }
}

async function checkService(service) {
  const checkStartedAt = Date.now();
  const checkedAt = nowIso();

  const serviceState = initState(service.url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  activeControllers.add(controller);

  try {
    const res = await fetchFn(service.url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "UptimeMonitor-Bot/1.0" },
    });
    const latencyMs = Date.now() - checkStartedAt;
    const isUp = res.status >= 200 && res.status < 300;

    serviceState.lastCode = res.status;
    serviceState.lastError = null;
    serviceState.lastErrorCode = null;
    serviceState.lastLatencyMs = latencyMs;
    serviceState.lastCheckedAt = checkedAt;

    if (isUp) {
      serviceState.consecutiveFailures = 0;

      if (serviceState.status === "DOWN" && serviceState.downNotified) {
        await postDiscordEmbed({
          title: `Service recovered: ${service.name}`,
          description: `URL: ${service.url}\nStatus: ${res.status}\nLatency: ${latencyMs}ms`,
          color: 0x00ff00,
        });
      }

      serviceState.downNotified = false;
      serviceState.status = "UP";
      pushHistory(service.url, {
        ts: checkedAt,
        status: "UP",
        httpStatus: res.status,
        latencyMs,
        error: null,
      });

      console.log(`[${checkedAt}] [UP] ${service.name} -> ${res.status} (${latencyMs}ms)`);
      return;
    }

    serviceState.consecutiveFailures += 1;
    const reachedThreshold = serviceState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;

    if (serviceState.status === "UP" && reachedThreshold) {
      await postDiscordEmbed({
        title: `Service down: ${service.name}`,
        description: `URL: ${service.url}\nStatus: ${res.status}\nFailures: ${serviceState.consecutiveFailures}`,
        color: 0xff0000,
      });
      serviceState.downNotified = true;
      serviceState.status = "DOWN";
    } else if (serviceState.status === "UNKNOWN" && reachedThreshold) {
      if (ALERT_ON_STARTUP_DOWN && !serviceState.downNotified) {
        await postDiscordEmbed({
          title: `Service down at startup: ${service.name}`,
          description: `URL: ${service.url}\nStatus: ${res.status}\nFailures: ${serviceState.consecutiveFailures}`,
          color: 0xff0000,
        });
        serviceState.downNotified = true;
      } else {
        serviceState.downNotified = false;
      }
      serviceState.status = "DOWN";
    }

    pushHistory(service.url, {
      ts: checkedAt,
      status: serviceState.status === "UNKNOWN" ? "DOWN" : serviceState.status,
      httpStatus: res.status,
      latencyMs,
      error: null,
    });

    console.warn(
      `[${checkedAt}] [WARN] ${service.name} -> ${res.status} (${serviceState.consecutiveFailures} fail)`
    );
  } catch (err) {
    if (err?.name === "AbortError" && shouldStop) {
      return;
    }

    const latencyMs = Date.now() - checkStartedAt;
    const message = err?.name === "AbortError" ? "Request timeout" : err.message;
    const errorCode = getErrorCode(err);

    serviceState.lastError = message;
    serviceState.lastErrorCode = errorCode;
    serviceState.lastCode = null;
    serviceState.lastLatencyMs = latencyMs;
    serviceState.lastCheckedAt = checkedAt;
    serviceState.consecutiveFailures += 1;

    const reachedThreshold = serviceState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;

    if (serviceState.status === "UP" && reachedThreshold) {
      await postDiscordEmbed({
        title: `Service unreachable: ${service.name}`,
        description: `URL: ${service.url}\nError: ${message}\nErrorCode: ${errorCode || "-"}\nFailures: ${serviceState.consecutiveFailures}`,
        color: 0xffa500,
      });
      serviceState.downNotified = true;
      serviceState.status = "DOWN";
    } else if (serviceState.status === "UNKNOWN" && reachedThreshold) {
      if (ALERT_ON_STARTUP_DOWN && !serviceState.downNotified) {
        await postDiscordEmbed({
          title: `Service unreachable at startup: ${service.name}`,
          description: `URL: ${service.url}\nError: ${message}\nErrorCode: ${errorCode || "-"}\nFailures: ${serviceState.consecutiveFailures}`,
          color: 0xffa500,
        });
        serviceState.downNotified = true;
      } else {
        serviceState.downNotified = false;
      }
      serviceState.status = "DOWN";
    }

    pushHistory(service.url, {
      ts: checkedAt,
      status: serviceState.status === "UNKNOWN" ? "DOWN" : serviceState.status,
      httpStatus: null,
      latencyMs,
      error: message,
      errorCode,
    });

    console.warn(
      `[${checkedAt}] [ERROR] ${service.name} -> ${message} [${errorCode || "NO_CODE"}] (${serviceState.consecutiveFailures} fail)`
    );
  } finally {
    clearTimeout(timeoutId);
    activeControllers.delete(controller);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

function interruptSleep() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }

  if (sleepResolve) {
    const resolve = sleepResolve;
    sleepResolve = null;
    resolve();
  }
}

function requestStop(signalName) {
  if (shouldStop) {
    return;
  }

  console.log(`[${nowIso()}] ${signalName} received, stopping monitor...`);
  shouldStop = true;
  interruptSleep();

  for (const controller of activeControllers) {
    try {
      controller.abort();
    } catch {}
  }
  activeControllers.clear();

  if (statusServer) {
    statusServer.close();
  }
}

async function runLoop() {
  while (!shouldStop) {
    const startedAt = Date.now();
    console.log(`[${nowIso()}] Starting scan of ${SERVICES.length} services...`);

    await Promise.allSettled(SERVICES.map((service) => checkService(service)));
    await persistJson();

    const duration = Date.now() - startedAt;
    const waitMs = Math.max(0, INTERVAL_MS - duration);
    console.log(`[${nowIso()}] Scan done in ${duration}ms. Next in ${waitMs}ms.`);

    if (!shouldStop && waitMs > 0) {
      await sleep(waitMs);
    }
  }

  console.log(`[${nowIso()}] Monitor stopped.`);
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

(async () => {
  await loadEnvFile();
  if (!process.env.DISCORD_WEBHOOK) {
    console.error("[FATAL] Missing DISCORD_WEBHOOK environment variable.");
    process.exit(1);
  }

  await ensureDataDir();
  await acquireLock();
  statusServer = startStatusServer();
  await loadHistoryFromDisk();
  await runLoop();
})().catch((err) => {
  console.error(`[${nowIso()}] Fatal monitor error:`, err);
  process.exit(1);
}).finally(async () => {
  await releaseLock();
});
