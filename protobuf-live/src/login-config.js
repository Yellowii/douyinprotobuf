import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { BASE } from "./paths.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const isDouyin = (host) =>
  host === "douyin.com" || host.endsWith(".douyin.com");

function filteredState(state) {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins))
    throw new Error("登录态配置格式无效");
  return {
    cookies: state.cookies.filter(
      (cookie) =>
        typeof cookie.domain === "string" &&
        isDouyin(cookie.domain.replace(/^\./, "")) &&
        typeof cookie.name === "string" &&
        typeof cookie.value === "string" &&
        (cookie.expires === -1 || cookie.expires > Date.now() / 1000),
    ),
    origins: state.origins.filter((item) => {
      try {
        const url = new URL(item.origin);
        return (
          url.protocol === "https:" &&
          isDouyin(url.hostname) &&
          Array.isArray(item.localStorage)
        );
      } catch {
        return false;
      }
    }),
  };
}
async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("无法读取本地登录配置");
  }
}
async function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (e) {
        if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(e.code))
          throw e;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

// Cookie 与完整浏览器状态只保存在被 Git 忽略的本地配置，接口仅返回元数据。
export class LoginConfig {
  constructor({
    directory = BASE,
    fallbackCookie = process.env.DOUYIN_COOKIE || "",
  } = {}) {
    this.envFile = path.join(directory, ".env");
    this.stateFile = path.join(
      directory,
      ".browser-profile",
      "login-state.json",
    );
    this.fallbackCookie = fallbackCookie;
    this.queue = Promise.resolve();
  }
  async load() {
    const text = await readOptional(this.envFile);
    let env;
    try {
      env = text === null ? {} : parseEnv(text);
    } catch {
      throw new Error("本地 .env 配置格式无效");
    }
    const cookie = Object.hasOwn(env, "DOUYIN_COOKIE")
      ? env.DOUYIN_COOKIE
      : this.fallbackCookie;
    if (/[\r\n]/.test(cookie)) throw new Error("Cookie 配置不可含换行");
    let storageState,
      savedAt = null;
    const raw = await readOptional(this.stateFile);
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        // 人工修改或清空 Cookie 后，旧浏览器状态不得覆盖新配置。
        if (
          cookie &&
          saved.version === 1 &&
          saved.cookie_sha256 === hash(cookie)
        ) {
          storageState = filteredState(saved.storage_state);
          savedAt = typeof saved.saved_at === "string" ? saved.saved_at : null;
        }
      } catch {
        /* 损坏的浏览器状态不妨碍使用 .env 中的 Cookie。 */
      }
    }
    return { cookie, storageState, savedAt };
  }
  async metadata() {
    const login = await this.load();
    return {
      configured: Boolean(login.cookie),
      browser_state: Boolean(login.storageState),
      saved_at: login.savedAt,
    };
  }
  save(context) {
    const task = this.queue.then(() => this.saveContext(context));
    this.queue = task.catch(() => {});
    return task;
  }
  async saveContext(context) {
    let cookie, storageState;
    try {
      storageState = filteredState(await context.storageState());
      // 从同一次快照生成 Header，避免读取期间浏览器刷新 Cookie 导致两份配置不一致。
      cookie = storageState.cookies
        .filter((c) => {
          const domain = c.domain.replace(/^\./, "");
          return (
            c.path === "/" &&
            (c.domain.startsWith(".")
              ? "live.douyin.com" === domain ||
                "live.douyin.com".endsWith("." + domain)
              : c.domain === "live.douyin.com")
          );
        })
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    } catch {
      throw new Error("浏览器已关闭或登录态读取失败，请重新打开浏览器");
    }
    if (!cookie) throw new Error("浏览器尚无抖音 Cookie，请完成登录后再保存");
    if (/[\r\n]/.test(cookie)) throw new Error("浏览器 Cookie 格式无效");
    const quote = ["'", '"', "`"].find((char) => !cookie.includes(char));
    if (!quote) throw new Error("Cookie 含不支持的配置分隔字符");
    const original = (await readOptional(this.envFile)) || "";
    // 删除旧的同名变量（含多行引号值），保留端口、目录等其他设置。
    const preserved = original.replace(
      /^[ \t]*(?:export[ \t]+)?DOUYIN_COOKIE[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\r\n]*)(?:[ \t]*#[^\r\n]*)?(?:\r?\n|$)/gm,
      "",
    );
    const env = `${preserved}${preserved && !preserved.endsWith("\n") ? "\n" : ""}DOUYIN_COOKIE=${quote}${cookie}${quote}\n`;
    const savedAt = new Date().toISOString();
    const previousState = await readOptional(this.stateFile);
    let stateWritten = false;
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await atomicWrite(
        this.stateFile,
        JSON.stringify(
          {
            version: 1,
            saved_at: savedAt,
            cookie_sha256: hash(cookie),
            storage_state: storageState,
          },
          null,
          2,
        ) + "\n",
      );
      stateWritten = true;
      await atomicWrite(this.envFile, env);
    } catch {
      if (stateWritten) {
        try {
          if (previousState === null)
            await fs.rm(this.stateFile, { force: true });
          else await atomicWrite(this.stateFile, previousState);
        } catch {
          throw new Error(
            "登录态保存失败，旧浏览器状态恢复失败；请检查配置目录权限后重新保存",
          );
        }
      }
      throw new Error("登录态保存失败，请检查本地配置文件写入权限");
    }
    return { configured: true, browser_state: true, saved_at: savedAt };
  }
}

export async function createLoginContext(
  browser,
  { cookie = "", storageState } = {},
) {
  const context = await browser.newContext({
    locale: "zh-CN",
    ...(storageState ? { storageState: filteredState(storageState) } : {}),
  });
  try {
    if (cookie && !storageState) {
      const cookies = cookie
        .split(";")
        .map((entry) => {
          const i = entry.indexOf("=");
          return i > 0
            ? {
                name: entry.slice(0, i).trim(),
                value: entry.slice(i + 1).trim(),
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
    return context;
  } catch {
    await context.close().catch(() => {});
    throw new Error("本地 Cookie 或浏览器登录态无效");
  }
}
