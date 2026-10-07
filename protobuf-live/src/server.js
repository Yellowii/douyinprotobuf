import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LiveClient } from "./live.js";
import { BrowserLive } from "./browser.js";
import { Journal } from "./journal.js";
import { paths } from "./paths.js";
import { writeArtifacts, readObservations } from "./dictionary.js";
import { ParserUpdater } from "./parser-update.js";
import { RawSource } from "./raw-source.js";
import { RawBatch } from "./raw-batch.js";
import { toBarrage } from "./barrage.js";

export async function createWorkbench(
  p,
  {
    port = Number(process.env.PORT || 8787),
    autoUpdate = process.env.PARSER_AUTO_UPDATE !== "false",
    updaterOptions = {},
    batchOutput = path.join(paths.output, "raw-batches"),
  } = {},
) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT 无效");
  const observations = await readObservations();
  await writeArtifacts(p, observations);
  let dictionary = JSON.parse(
    await fs.readFile(path.join(paths.dist, "proto.dict"), "utf8"),
  );
  const direct = new LiveClient(p),
    browser = new BrowserLive(p),
    raw = new RawSource(p),
    journal = new Journal();
  await journal.open();
  const clients = new Set(),
    barrageClients = new Set(),
    token = randomBytes(32).toString("hex");
  let active = null,
    lastStart = 0,
    busy = false;
  const broadcast = (event, value, targets = clients) => {
    const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const c of targets) {
      if (c.writableLength > 1024 * 1024) {
        c.destroy();
        targets.delete(c);
      } else c.write(data);
    }
  };
  const recentSamples = [];
  let artifactQueue = Promise.resolve();
  const serializeArtifacts = (job) => {
    const task = artifactQueue.then(job);
    artifactQueue = task.catch(() => {});
    return task;
  };
  const updater = new ParserUpdater(p, {
    ...updaterOptions,
    observations,
    withCommit: serializeArtifacts,
    validateCandidate: async (next) => {
      // 对最近的真实帧重放：原版可解析的载荷不可在新版退化为异常。
      const { decodePacket } = await import("./decode.js");
      for (const bytes of recentSamples) {
        const before = decodePacket(p, bytes),
          after = decodePacket(next, bytes);
        for (let i = 0; i < before.messages.length; i++)
          if (
            before.messages[i].status === "decoded" &&
            after.messages[i]?.status !== "decoded"
          )
            throw new Error("新版 Parser 无法解码最近的真实帧");
      }
      await updaterOptions.validateCandidate?.(next, p);
    },
    activate: async (next, artifacts) => {
      p = next;
      dictionary = artifacts.dictionary;
      direct.p = next;
      browser.p = next;
      raw.p = next;
      batch.p = next;
      await updaterOptions.activate?.(next, artifacts);
    },
  });
  const batch = new RawBatch(p, {
    output: batchOutput,
    finish: async (report) => {
      for (const [name, ids] of Object.entries(report.observations)) {
        const current = (observations[name] ||= []);
        for (const id of ids) if (!current.includes(id)) current.push(id);
      }
      await serializeArtifacts(async () => {
        await writeArtifacts(p, observations);
        dictionary = JSON.parse(
          await fs.readFile(path.join(paths.dist, "proto.dict"), "utf8"),
        );
      });
    },
  });
  batch.on("status", (s) => {
    broadcast("status", s);
    broadcast("batch-progress", s);
  });
  batch.on("failure", (e) => broadcast("failure", e));
  // 批量任务自行保存完整 JSON；页面仅限频预览，避免挤满实时日志队列。
  batch.on("packet", (packet) => broadcast("packet", packet));
  updater.on("status", (s) => broadcast("parser-update", s));
  updater.on("failure", (e) => broadcast("failure", e));
  if (autoUpdate) await updater.schedule();
  else await updater.restore();
  for (const source of [direct, browser, raw]) {
    source.on("raw", (bytes) => {
      if (bytes.length <= 1024 * 1024) {
        recentSamples.push(bytes);
        if (recentSamples.length > 16) recentSamples.shift();
      }
      try {
        journal.appendRaw(bytes, source === direct ? "direct" : "browser");
      } catch {
        source.stop();
        broadcast("failure", { error: "原始包写入队列已满，连接已停止" });
      }
    });
    source.on("status", (s) => broadcast("status", s));
    source.on("failure", (e) => {
      try {
        journal.append(e, true);
      } catch {
        source.stop();
      }
      broadcast("failure", e);
    });
    source.on("packet", (packet) => {
      for (const m of packet.messages || []) {
        if (m.type && Number.isInteger(m.msg_type)) {
          const ids = (observations[m.type] ||= []);
          if (!ids.includes(m.msg_type)) ids.push(m.msg_type);
        }
      }
      try {
        journal.append(packet).then(() => {
          if (journal.failure) {
            source.stop();
            broadcast("failure", { error: "日志写入失败，连接已停止" });
          }
        });
        broadcast("packet", packet);
        for (const m of packet.messages || []) {
          const barrage = toBarrage(m, packet.received_at);
          if (barrage) {
            broadcast("barrage", barrage);
            broadcast("barrage", barrage, barrageClients);
          }
        }
      } catch {
        source.stop();
        broadcast("failure", { error: "日志队列已满，连接已停止" });
      }
    });
  }
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address().port;
    const hosts = new Set([
      `127.0.0.1:${actualPort}`,
      `localhost:${actualPort}`,
    ]);
    if (!hosts.has(req.headers.host)) {
      json(res, 403, { error: "工作台只允许本机访问" });
      return;
    }
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([
        `http://127.0.0.1:${actualPort}`,
        `http://localhost:${actualPort}`,
      ]).has(origin)
    ) {
      json(res, 403, { error: "不允许跨源请求" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/api/session") {
        json(res, 200, {
          token,
          status: active?.status || { state: "stopped" },
          protocols: p.types.size,
          parser_update: updater.status,
          batch: batch.status,
          raw_directory: process.env.RAW_PROTO_DIR
            ? path.normalize(process.env.RAW_PROTO_DIR)
            : "",
          fields: [...p.types.values()].reduce(
            (n, t) => n + t.fields.length,
            0,
          ),
        });
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/parser-update") {
        json(res, 200, updater.status);
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/batch-report") {
        if (!batch.report) {
          json(res, 404, { error: "尚无批量解析报告" });
          return;
        }
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="raw-audit.report.json"',
        );
        json(res, 200, batch.report);
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/schema") {
        const name = u.searchParams.get("name");
        json(
          res,
          name && !Object.hasOwn(dictionary, name) ? 404 : 200,
          name && Object.hasOwn(dictionary, name)
            ? dictionary[name]
            : name
              ? { error: "未知消息类型" }
              : Object.keys(dictionary),
        );
        return;
      }
      if (
        req.method === "GET" &&
        ["/events", "/api/barrage/events"].includes(u.pathname)
      ) {
        const targets = u.pathname === "/events" ? clients : barrageClients;
        if (clients.size + barrageClients.size >= 8) {
          json(res, 429, { error: "工作台页面连接数已满" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `event: status\ndata: ${JSON.stringify(active?.status || { state: "stopped" })}\n\n`,
        );
        targets.add(res);
        req.on("close", () => targets.delete(res));
        return;
      }
      if (
        req.method === "POST" &&
        ["/api/start", "/api/stop", "/api/parser-update"].includes(u.pathname)
      ) {
        if (req.headers["x-workbench-token"] !== token) {
          json(res, 403, { error: "工作台令牌无效" });
          return;
        }
        if (busy) {
          json(res, 409, { error: "连接操作处理中" });
          return;
        }
        busy = true;
        try {
          if (u.pathname === "/api/parser-update") {
            json(
              res,
              200,
              await updater.check({
                page: browser.page?.isClosed() === false ? browser.page : null,
              }),
            );
            return;
          }
          if (u.pathname === "/api/stop") {
            await direct.stop();
            await browser.stop();
            await raw.stop();
            await batch.stop();
            active = null;
            await serializeArtifacts(async () => {
              await writeArtifacts(p, observations);
              dictionary = JSON.parse(
                await fs.readFile(path.join(paths.dist, "proto.dict"), "utf8"),
              );
            });
            json(res, 200, { state: "stopped" });
            return;
          }
          if (
            active &&
            !["stopped", "completed", "cancelled", "failed"].includes(
              active.status.state,
            )
          )
            throw new Error("请先停止当前连接");
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 20000) throw new Error("请求体过大");
          }
          const config = JSON.parse(body);
          if (!["browser", "direct", "raw", "raw-batch"].includes(config.mode))
            throw new Error("连接模式无效");
          if (
            ["browser", "direct"].includes(config.mode) &&
            Date.now() - lastStart < 30000
          )
            throw new Error("连接操作至少间隔 30 秒");
          active =
            config.mode === "browser"
              ? browser
              : config.mode === "raw"
                ? raw
                : config.mode === "raw-batch"
                  ? batch
                  : direct;
          if (["browser", "direct"].includes(config.mode))
            lastStart = Date.now();
          const cookie = process.env.DOUYIN_COOKIE || "";
          await active.start(
            config.mode === "browser"
              ? {
                  roomUrl: config.roomUrl,
                  cookie,
                  headless: config.visible !== true,
                }
              : ["raw", "raw-batch"].includes(config.mode)
                ? { directory: config.directory || process.env.RAW_PROTO_DIR }
                : {
                    url: config.wss || process.env.DOUYIN_WSS_URL,
                    cookie,
                    modern: config.modern === true,
                    userAgent: process.env.DOUYIN_USER_AGENT || "Mozilla/5.0",
                  },
          );
          json(res, 200, active.status);
          return;
        } finally {
          busy = false;
        }
      }
      const staticFiles = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      };
      if (req.method === "GET" && staticFiles[u.pathname]) {
        res.writeHead(200, {
          "Content-Type": u.pathname.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : u.pathname.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        });
        res.end(
          await fs.readFile(path.join(paths.static, staticFiles[u.pathname])),
        );
        return;
      }
      json(res, 404, { error: "未找到资源" });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });
  const keepAlive = setInterval(() => {
    for (const c of [...clients, ...barrageClients]) c.write(": heartbeat\n\n");
  }, 20000);
  keepAlive.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      clearInterval(keepAlive);
      await updater.close();
      await direct.stop();
      await browser.stop();
      await raw.stop();
      await batch.stop();
      for (const c of [...clients, ...barrageClients]) c.end();
      await journal.close();
      await serializeArtifacts(() => writeArtifacts(p, observations));
      await new Promise((r) => server.close(r));
    },
  };
}
