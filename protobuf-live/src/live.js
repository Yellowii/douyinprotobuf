import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { decodePacket, heartbeat, MAX_PACKET } from "./decode.js";

export function validateTarget(raw, { allowLocalTest = false } = {}) {
  const u = new URL(raw);
  if (u.username || u.password) throw new Error("URL 不允许包含凭据");
  if (allowLocalTest && u.protocol === "ws:" && u.hostname === "127.0.0.1")
    return u;
  if (u.protocol !== "wss:") throw new Error("必须使用 WSS 地址");
  if (!(u.hostname === "douyin.com" || u.hostname.endsWith(".douyin.com")))
    throw new Error("长连接域名必须属于 douyin.com");
  if (u.port && u.port !== "443") throw new Error("WSS 只允许标准端口");
  return u;
}
export class LiveClient extends EventEmitter {
  constructor(p, options = {}) {
    super();
    this.p = p;
    this.options = {
      minConnectMs: 30000,
      heartbeatMs: 15000,
      maxAttempts: 5,
      maxQueue: 100,
      ...options,
    };
    this.status = { state: "stopped", attempts: 0, received: 0, errors: 0 };
    this.generation = 0;
    this.lastConnect = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
  }
  update(state, detail = {}) {
    this.status = { ...this.status, state, ...detail };
    this.emit("status", this.status);
  }
  async start({ url, cookie = "", modern = false, userAgent = "Mozilla/5.0" }) {
    validateTarget(url, this.options);
    if (/[\r\n]/.test(cookie + userAgent))
      throw new Error("Cookie 或 User-Agent 含非法换行");
    if (this.status.state !== "stopped") throw new Error("已有连接，请先停止");
    if (Date.now() - this.lastConnect < this.options.minConnectMs)
      throw new Error("连接冷却中，请稍后重试");
    this.config = { url, cookie, modern, userAgent };
    this.status.attempts = 0;
    this.status.received = 0;
    this.status.errors = 0;
    this.generation++;
    this.connect(this.generation);
  }
  connect(g) {
    if (g !== this.generation) return;
    this.lastConnect = Date.now();
    this.update("connecting", { attempts: this.status.attempts + 1 });
    const ws = (this.ws = new WebSocket(this.config.url, {
      headers: {
        Cookie: this.config.cookie,
        "User-Agent": this.config.userAgent,
        Origin: "https://live.douyin.com",
      },
      maxPayload: MAX_PACKET,
      handshakeTimeout: 15000,
      perMessageDeflate: false,
      followRedirects: false,
    }));
    let blocked = false;
    ws.on("unexpected-response", (_req, res) => {
      blocked = [401, 403, 429].includes(res.statusCode);
      this.emit("failure", {
        stage: "handshake",
        status: res.statusCode,
        error: "服务端拒绝握手",
      });
      res.resume();
      ws.terminate();
      if (blocked) {
        this.update("blocked", {
          reason: "鉴权失败或限流；更新 Cookie/WSS 后手动重试",
        });
        this.generation++;
        clearInterval(this.hb);
      }
    });
    ws.on("open", () => {
      if (g !== this.generation) {
        ws.close();
        return;
      }
      this.lastReceive = Date.now();
      this.update("connected");
      this.hb = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastReceive > 90000) {
          ws.terminate();
          return;
        }
        try {
          ws.send(
            heartbeat(this.p, String(Date.now()), {
              modern: this.config.modern,
            }),
          );
        } catch {
          ws.terminate();
        }
      }, this.options.heartbeatMs);
      this.hb.unref();
    });
    ws.on("message", (bytes, binary) => {
      if (!binary || g !== this.generation) return;
      this.lastReceive = Date.now();
      if (this.pending >= this.options.maxQueue) {
        this.emit("failure", {
          stage: "queue",
          error: "解码队列已满，停止连接以避免丢包",
        });
        this.stop();
        return;
      }
      this.emit("raw", Buffer.from(bytes));
      this.pending++;
      this.queue = this.queue
        .then(async () => {
          if (g !== this.generation) return;
          try {
            const packet = decodePacket(this.p, Buffer.from(bytes), {
              modernAck: this.config.modern,
            });
            if (packet.ack && ws.readyState === WebSocket.OPEN)
              ws.send(packet.ack());
            this.status.received++;
            this.emit("packet", packet);
          } catch (e) {
            this.status.errors++;
            this.emit("failure", { stage: "decode", error: e.message });
          }
        })
        .finally(() => this.pending--);
    });
    ws.on("error", () => {
      if (g === this.generation)
        this.emit("failure", {
          stage: "transport",
          error: "长连接发生传输错误；详情请检查 Cookie/WSS 有效期",
        });
    });
    ws.on("close", (code) => {
      clearInterval(this.hb);
      if (g !== this.generation || blocked) return;
      if ([1008, 4001, 4003, 4429].includes(code)) {
        this.update("blocked", {
          reason: "服务端策略关闭连接；请手动检查凭据",
        });
        return;
      }
      if (this.status.attempts >= this.options.maxAttempts) {
        this.update("blocked", { reason: "达到重试上限；等待人工检查" });
        return;
      }
      const delay =
        Math.max(
          this.options.minConnectMs,
          Math.min(300000, 30000 * 2 ** (this.status.attempts - 1)),
        ) + Math.floor(Math.random() * 3000);
      this.update("waiting", { retry_after_ms: delay });
      this.retry = setTimeout(() => this.connect(g), delay);
      this.retry.unref();
    });
  }
  async stop() {
    this.generation++;
    clearInterval(this.hb);
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.on("error", () => {});
      ws.terminate();
    }
    await this.queue;
    this.config = null;
    this.update("stopped");
  }
}
