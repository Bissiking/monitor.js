// status-server.js
// Minimal status page and JSON API server.

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = process.env.MONITOR_DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

const STATUS_FILE = path.join(DATA_DIR, "status.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const STATUS_PAGE_FILE = path.join(PUBLIC_DIR, "status.html");

function json(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function sendFile(res, filePath, contentType) {
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      json(res, 404, { error: "Not found" });
      return;
    }

    json(res, 500, { error: "Failed to read file", detail: err.message });
  }
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function startStatusServer(options = {}) {
  const host = options.host || process.env.STATUS_HOST || "0.0.0.0";
  const port = Number.parseInt(
    String(options.port || process.env.STATUS_PORT || "3010"),
    10
  );

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/health") {
        return json(res, 200, { ok: true, at: new Date().toISOString() });
      }

      if (url.pathname === "/api/status") {
        try {
          const data = await readJsonFile(STATUS_FILE);
          return json(res, 200, { ...data, statusUiPort: port });
        } catch (err) {
          if (err.code === "ENOENT") {
            return json(res, 200, {
              updatedAt: null,
              services: [],
              message: "No status yet",
              statusUiPort: port,
            });
          }
          return json(res, 500, { error: "Cannot read status.json", detail: err.message });
        }
      }

      if (url.pathname === "/api/history") {
        try {
          const data = await readJsonFile(HISTORY_FILE);
          return json(res, 200, data);
        } catch (err) {
          if (err.code === "ENOENT") {
            return json(res, 200, { updatedAt: null, services: [], message: "No history yet" });
          }
          return json(res, 500, { error: "Cannot read history.json", detail: err.message });
        }
      }

      if (url.pathname === "/" || url.pathname === "/status") {
        return sendFile(res, STATUS_PAGE_FILE, "text/html; charset=utf-8");
      }

      return json(res, 404, { error: "Not found" });
    } catch (err) {
      return json(res, 500, { error: "Unhandled server error", detail: err.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`[status-server] listening on http://${host}:${port}`);
  });

  return server;
}

module.exports = { startStatusServer };

if (require.main === module) {
  startStatusServer();
}
