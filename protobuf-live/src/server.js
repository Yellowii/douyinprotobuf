import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LiveClient } from "./live.js";
import { BrowserLive } from "./browser.js";
import { Journal } from "./journal.js";
import { paths } from "./paths.js";
import { writeArtifacts, readObservations } from "./dictionary.js";

export async function createWorkbench(
  p,
  { port = Number(process.env.PORT || 8787) } = {},
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
    journal = new Journal();
  await journal.open();
  const clients = new Set(),
    token = randomBytes(32).toString("hex");
  let active = null,
    lastStart = 0,
    busy = false;
  const broadcast = (event, value) => {
    const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const c of clients) {
      if (c.writableLength > 1024 * 1024) {
        c.destroy();
        clients.delete(c);
      } else c.write(data);
    }
  };
  for (const source of [direct, browser]) {
    source.on("raw", (bytes) => {
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
          fields: [...p.types.values()].reduce(
            (n, t) => n + t.fields.length,
            0,
          ),
        });
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
      if (req.method === "GET" && u.pathname === "/events") {
        if (clients.size >= 8) {
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
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (
        req.method === "POST" &&
        ["/api/start", "/api/stop"].includes(u.pathname)
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
          if (u.pathname === "/api/stop") {
            await direct.stop();
            await browser.stop();
            active = null;
            await writeArtifacts(p, observations);
            dictionary = JSON.parse(
              await fs.readFile(path.join(paths.dist, "proto.dict"), "utf8"),
            );
            json(res, 200, { state: "stopped" });
            return;
          }
          if (active && active.status.state !== "stopped")
            throw new Error("请先停止当前连接");
          if (Date.now() - lastStart < 30000)
            throw new Error("连接操作至少间隔 30 秒");
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 20000) throw new Error("请求体过大");
          }
          const config = JSON.parse(body);
          if (!["browser", "direct"].includes(config.mode))
            throw new Error("连接模式无效");
          active = config.mode === "browser" ? browser : direct;
          lastStart = Date.now();
          const cookie = process.env.DOUYIN_COOKIE || "";
          await active.start(
            config.mode === "browser"
              ? {
                  roomUrl: config.roomUrl,
                  cookie,
                  headless: config.visible !== true,
                }
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
    for (const c of clients) c.write(": heartbeat\n\n");
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
      await direct.stop();
      await browser.stop();
      for (const c of clients) c.end();
      await journal.close();
      await writeArtifacts(p, observations);
      await new Promise((r) => server.close(r));
    },
  };
}
