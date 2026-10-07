import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const SELF_PATHS = new Set([
  "/webcast/user/me/",
  "/aweme/v1/web/user/profile/self/",
]);
const douyinHost = (host) =>
  host === "douyin.com" || host.endsWith(".douyin.com");
export function accountAvatar(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["douyinpic.com", "byteimg.com", "ibyteimg.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      )
      ? url.href
      : "";
  } catch {
    return "";
  }
}
function idString(value) {
  return typeof value === "string" && /^\d+$/.test(value)
    ? value
    : Number.isSafeInteger(value) && value > 0
      ? String(value)
      : "";
}
export function normalizeAccount(reply, pathname) {
  if (!SELF_PATHS.has(pathname))
    return { state: "unknown", user: null, reason: "不是当前账号接口" };
  if (typeof reply === "string") {
    try {
      if (reply.length > 1024 * 1024) throw new Error();
      reply = JSON.parse(reply);
    } catch {
      return {
        state: "error",
        user: null,
        reason: "官方账号响应不可解析，请检查浏览器页面验证提示",
      };
    }
  }
  if (Number(reply?.status_code) === 8 && pathname.endsWith("/profile/self/"))
    return { state: "anonymous", user: null, reason: "官方接口要求登录" };
  if (reply?.status_code !== 0)
    return {
      state: "error",
      user: null,
      reason: "官方账号接口未确认登录，请在浏览器检查登录或验证提示",
    };
  const data = pathname === "/webcast/user/me/" ? reply.data : reply.user;
  if (!data || typeof data !== "object")
    return { state: "anonymous", user: null, reason: "当前浏览器是访客会话" };
  const id = idString(data.id_str ?? data.uid_str ?? data.uid ?? data.id);
  if (!id || /^0+$/.test(id))
    return { state: "anonymous", user: null, reason: "当前浏览器是访客会话" };
  const avatars = [data.avatar_thumb, data.avatar_medium, data.avatar_large];
  const avatar =
    avatars
      .flatMap((a) => a?.url_list || [])
      .map(accountAvatar)
      .find(Boolean) || "";
  return {
    state: "authenticated",
    reason: "官方接口已确认当前账号",
    user: {
      id,
      nickname: String(data.nickname || "抖音用户").slice(0, 100),
      account: String(
        data.display_id || data.unique_id || data.short_id || "",
      ).slice(0, 100),
      avatar,
    },
  };
}

// 复用站点 SDK 的当前用户请求，保留其签名和请求参数；服务仅向工作台返回必要展示字段。
async function queryOfficialAccount(page) {
  return page.evaluate(async () => {
    const query = async () => {
      const chunks = window.webpackChunkdouyin_live_v2;
      if (Array.isArray(chunks)) {
        const key = Symbol.for("webcast-workbench-require");
        if (!window[key])
          chunks.push([
            ["workbench-account-" + Date.now()],
            {},
            (require) => {
              window[key] = require;
            },
          ]);
        const require = window[key];
        if (require) {
          for (const entry of chunks) {
            for (const [id, factory] of Object.entries(entry[1] || {})) {
              if (
                typeof factory !== "function" ||
                !factory.toString().includes('"/webcast/user/me/"')
              )
                continue;
              let exports;
              try {
                exports = require(id);
              } catch {
                continue;
              }
              if (!exports || typeof exports !== "object") continue;
              const getMe = Object.values(exports).find(
                (value) =>
                  typeof value === "function" &&
                  value.toString().includes('"/webcast/user/me/"'),
              );
              if (getMe)
                return {
                  body: (await getMe()).data,
                  pathname: "/webcast/user/me/",
                };
            }
          }
        }
      }
      return { unavailable: true };
    };
    return Promise.race([
      query().catch(() => ({ unavailable: true })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ unavailable: true }), 8000),
      ),
    ]);
  });
}

export class AccountMonitor extends EventEmitter {
  constructor() {
    super();
    this.generation = 0;
    this.status = {
      state: "inactive",
      user: null,
      checked_at: null,
      reason: "请先打开直播间浏览器，再检测当前账号",
    };
    this.lastQuery = 0;
  }
  update(value) {
    this.status = { ...value, checked_at: new Date().toISOString() };
    this.emit("status", this.status);
    return this.status;
  }
  attach(page, { schedule = true } = {}) {
    this.stop();
    this.abort = new AbortController();
    this.page = page;
    this.lastQuery = 0;
    const generation = this.generation;
    this.listener = async (response) => {
      try {
        const url = new URL(response.url());
        if (
          url.protocol !== "https:" ||
          !douyinHost(url.hostname) ||
          !SELF_PATHS.has(url.pathname)
        )
          return;
        const text = await response.text();
        if (text.length > 1024 * 1024 || generation !== this.generation) return;
        this.accept(JSON.parse(text), url.pathname);
      } catch {
        /* 不记录响应体或 SDK 错误，避免凭据进入日志。 */
      }
    };
    this.onClose = () => this.stop();
    page.on("response", this.listener);
    page.on("close", this.onClose);
    this.update({
      state: "unknown",
      user: null,
      reason: "等待官方页面返回当前账号",
    });
    if (schedule) {
      this.timer = setInterval(() => {
        void this.check();
      }, 60000);
      this.timer.unref();
    }
  }
  accept(body, pathname) {
    const normalized = normalizeAccount(body, pathname);
    if (normalized.state === "unknown") return this.status;
    return this.update({ ...normalized, source: "official-self-api" });
  }
  async check({ force = false } = {}) {
    if (!this.page || this.page.isClosed()) return this.status;
    if (this.pending) return this.pending;
    const cooldown = force ? 15000 : 60000;
    if (Date.now() - this.lastQuery < cooldown) return this.status;
    this.lastQuery = Date.now();
    const page = this.page,
      generation = this.generation;
    const before = this.status;
    this.update({
      state: "checking",
      user: null,
      reason: "正在查询官方当前账号",
    });
    const work = (async () => {
      try {
        const result = await queryOfficialAccount(page);
        if (generation !== this.generation) return this.status;
        if (!result?.unavailable)
          return this.accept(result.body, result.pathname);
        // SDK 自己的响应可能先于本次查询返回；不能用查询不可用覆盖新结果。
        if (this.status.state !== "checking") return this.status;
        return this.update({
          state: "error",
          user: null,
          reason: "官方当前账号查询暂不可用，请完成页面验证后再检测",
          last_verified_at:
            before.state === "authenticated"
              ? before.checked_at
              : before.last_verified_at,
        });
      } catch {
        if (generation === this.generation && this.status.state === "checking")
          this.update({
            state: "error",
            user: null,
            reason: "浏览器账号检测失败，请检查页面登录或验证提示",
          });
        return this.status;
      }
    })();
    this.pending = work;
    try {
      return await work;
    } finally {
      if (this.pending === work) this.pending = null;
    }
  }
  async confirmForSave() {
    const generation = this.generation;
    while (
      this.page &&
      !this.page.isClosed() &&
      generation === this.generation
    ) {
      if (this.pending) await this.pending;
      if (generation !== this.generation || !this.page || this.page.isClosed())
        break;
      const remaining = this.lastQuery + 15000 - Date.now();
      if (remaining > 0) {
        this.update({
          state: "checking",
          user: null,
          reason: "正在等待请求冷却，随后重新确认账号再保存",
        });
        try {
          await delay(remaining + 5, null, { signal: this.abort.signal });
        } catch {
          break;
        }
        continue;
      }
      const result = await this.check({ force: true });
      if (generation !== this.generation || !this.page || this.page.isClosed())
        break;
      if (result.state !== "authenticated")
        throw new Error(
          "当前浏览器尚未确认账号登录，请完成登录并检测到账号后再保存；旧配置已保留",
        );
      return result;
    }
    throw new Error("浏览器已关闭，登录态未保存；旧配置已保留");
  }
  stop() {
    this.generation++;
    this.abort?.abort();
    clearInterval(this.timer);
    this.page?.off("response", this.listener);
    this.page?.off("close", this.onClose);
    this.page = null;
    this.listener = null;
    this.onClose = null;
    this.pending = null;
    this.update({
      state: "inactive",
      user: null,
      reason: "浏览器未打开；已保存配置不代表账号仍已登录",
    });
  }
}
