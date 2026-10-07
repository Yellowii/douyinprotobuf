import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { decodePacket, MAX_PACKET } from "./decode.js";

export function validateRoom(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "live.douyin.com" ||
    u.username ||
    u.password ||
    u.port ||
    !/^\/\d+\/?$/.test(u.pathname)
  )
    throw new Error("请输入 https://live.douyin.com/数字房间号");
  return u;
}
export class BrowserLive extends EventEmitter {
  constructor(p) {
    super();
    this.p = p;
    this.status = { state: "stopped", received: 0, errors: 0 };
    this.queue = Promise.resolve();
    this.pending = 0;
    this.generation = 0;
    this.lastStart = 0;
  }
  update(state, extra = {}) {
    this.status = { ...this.status, state, ...extra };
    this.emit("status", this.status);
  }
  async start({ roomUrl, cookie = "", headless = true }) {
    validateRoom(roomUrl);
    if (this.status.state !== "stopped")
      throw new Error("已有浏览器连接，请先停止");
    if (Date.now() - this.lastStart < 30000)
      throw new Error("连接冷却中，请稍后重试");
    this.lastStart = Date.now();
    const g = ++this.generation;
    this.status = { state: "stopped", received: 0, errors: 0 };
    this.update("connecting");
    try {
      const candidates = [
        process.env.BROWSER_EXECUTABLE,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].filter(Boolean);
      let executablePath;
      for (const f of candidates)
        try {
          await fs.access(f);
          executablePath = f;
          break;
        } catch {}
      if (!executablePath)
        throw new Error("未找到 Chrome/Edge；请设置 BROWSER_EXECUTABLE");
      this.browser = await chromium.launch({ executablePath, headless });
      const context = await this.browser.newContext({ locale: "zh-CN" });
      if (cookie) {
        const cookies = cookie
          .split(";")
          .map((x) => {
            const i = x.indexOf("=");
            return i > 0
              ? {
                  name: x.slice(0, i).trim(),
                  value: x.slice(i + 1).trim(),
                  domain: ".douyin.com",
                  path: "/",
                  secure: true,
                  sameSite: "Lax",
                }
              : null;
          })
          .filter(Boolean);
        await context.addCookies(cookies);
      }
      if (g !== this.generation) {
        await this.browser.close();
        return;
      }
      const page = (this.page = await context.newPage());
      page.on("websocket", (ws) => {
        const url = new URL(ws.url());
        if (
          !url.hostname.endsWith(".douyin.com") ||
          !url.pathname.includes("/webcast/im/")
        )
          return;
        this.update("connected", {
          mode: "browser",
          transport: "官方浏览器 WebCast",
          reason: null,
        });
        clearTimeout(this.wait);
        ws.on("framereceived", (event) => {
          if (g !== this.generation || typeof event.payload === "string")
            return;
          if (event.payload.length > MAX_PACKET || this.pending >= 100) {
            this.emit("failure", {
              stage: "browser-queue",
              error: "浏览器解码队列或帧大小超过限制",
            });
            this.stop();
            return;
          }
          this.emit("raw", Buffer.from(event.payload));
          this.pending++;
          this.queue = this.queue
            .then(() => {
              if (g !== this.generation) return;
              try {
                const packet = decodePacket(this.p, event.payload);
                this.status.received++;
                this.emit("packet", packet);
              } catch (e) {
                this.status.errors++;
                this.emit("failure", {
                  stage: "browser-decode",
                  error: e.message,
                });
              }
            })
            .finally(() => this.pending--);
        });
        ws.on("close", () => {
          if (g === this.generation)
            this.update("waiting", {
              reason: "官方 SDK 负责连接恢复；工程不自动刷新页面",
            });
        });
      });
      this.wait = setTimeout(() => {
        if (g === this.generation && this.status.state === "connecting") {
          this.update("blocked", {
            reason:
              "30 秒内未发现官方 WebCast 连接；请检查开播状态、Cookie 或验证码",
          });
        }
      }, 30000);
      this.wait.unref();
      await page.goto(roomUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      this.browser.on("disconnected", () => {
        if (g === this.generation)
          this.update("blocked", { reason: "浏览器已关闭；需手动重连" });
      });
    } catch (e) {
      clearTimeout(this.wait);
      this.update("blocked", {
        reason: /Chrome\/Edge/.test(e.message)
          ? e.message
          : "浏览器连接失败；检查房间、浏览器及 Cookie 配置",
      });
      if (this.browser) await this.browser.close().catch(() => {});
      throw new Error(this.status.reason);
    }
  }
  async stop() {
    this.generation++;
    clearTimeout(this.wait);
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (browser) await browser.close().catch(() => {});
    await this.queue;
    this.update("stopped");
  }
}
