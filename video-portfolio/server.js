#!/usr/bin/env node
/* Tiny zero-dependency studio server.
   Serves the site and lets studio.html write video files + data.json straight to disk.
   Usage: npm start   (or: node server.js)  →  http://localhost:4321 */

const http = require("node:http");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const WRITABLE = ["videos", "images"];
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
};

function safePath(rel) {
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    decoded = rel;
  }
  const clean = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(ROOT, clean);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function canWrite(full) {
  const rel = path.relative(ROOT, full).split(path.sep);
  return rel.length > 1 && WRITABLE.includes(rel[0]);
}

async function readBody(req, limit = 2 * 1024 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleFileWrite(req, res, target, method) {
  if (!target || !canWrite(target)) return send(res, 403, "not allowed");

  if (method === "DELETE") {
    await fsp.rm(target, { force: true });
    return send(res, 200, "deleted");
  }

  // Stream straight to disk so huge videos never sit in memory.
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + ".part";
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD) return cb(new Error("file too large"));
      cb(null, chunk);
    }
  });
  await pipeline(req, counter, fs.createWriteStream(tmp));
  await fsp.rename(tmp, target);
  send(res, 200, `ok ${bytes}`);
}

async function handleDataWrite(req, res) {
  const raw = await readBody(req, 32 * 1024 * 1024);
  const parsed = JSON.parse(raw.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.videos)) {
    return send(res, 400, "invalid data.json: needs a videos array");
  }
  await fsp.writeFile(path.join(ROOT, "data.json"), JSON.stringify(parsed, null, 2) + "\n");
  send(res, 200, "saved");
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = safePath(rel);
  if (!full) return send(res, 403, "forbidden");

  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "not found");
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;

    // Range support so video seeking works while you preview locally.
    if (range && type.startsWith("video/")) {
      const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-");
      const start = Number(startRaw) || 0;
      const end = endRaw ? Number(endRaw) : stat.size - 1;
      res.writeHead(206, {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": end - start + 1
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      "content-type": type,
      "content-length": stat.size,
      "accept-ranges": "bytes",
      "cache-control": ext === ".html" || ext === ".json" ? "no-store" : "public, max-age=60"
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  // Preview hosts are cross-origin iframes in some setups.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    if (pathname === "/api/health") {
      return send(res, 200, JSON.stringify({ ok: true, mode: "local", root: ROOT, writable: WRITABLE }), {
        "content-type": "application/json"
      });
    }
    if (pathname === "/api/data" && req.method === "PUT") return await handleDataWrite(req, res);
    if (pathname === "/api/file" && (req.method === "PUT" || req.method === "DELETE")) {
      return await handleFileWrite(req, res, safePath(url.searchParams.get("path") || ""), req.method);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    send(res, 400, String(err.message || err));
  }
});

server.listen(PORT, HOST, () => {
  console.log("\n  Video portfolio studio server running\n");
  console.log(`  →  http://localhost:${PORT}/studio.html   (edit + upload)`);
  console.log(`  →  http://localhost:${PORT}/              (the public site)\n`);
  console.log("  Files land in ./videos and ./images, content is saved to ./data.json");
  console.log("  Press Ctrl+C to stop.\n");
});
