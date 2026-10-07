import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

export function validateOfficialModule(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "lf-webcast-platform.bytetos.com" ||
    u.port ||
    u.username ||
    u.password ||
    !/^\/obj\/webcast-platform-cdn\/webcast\/douyin_live\/chunks\/(live-schema|transport-schema)[\w.-]*\.js$/.test(
      u.pathname,
    )
  )
    throw new Error("仅允许抖音官方 CDN 协议模块");
  return u;
}
export async function browserExecutable() {
  for (const f of [
    process.env.BROWSER_EXECUTABLE,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean))
    try {
      await fs.access(f);
      return f;
    } catch {}
  throw new Error("未找到 Chrome/Edge；请配置 BROWSER_EXECUTABLE");
}

export async function fetchOfficialModules(urls) {
  const result = [];
  for (const raw of urls) {
    const u = validateOfficialModule(raw);
    const response = await fetch(u, {
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`官方 Parser 下载失败：HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > 8 * 1024 * 1024)
      throw new Error("官方 Parser 超过大小上限");
    const chunks = [];
    let length = 0;
    for await (const c of response.body) {
      length += c.length;
      if (length > 8 * 1024 * 1024) throw new Error("官方 Parser 超过大小上限");
      chunks.push(c);
    }
    result.push({
      file: path.basename(u.pathname),
      url: u.href,
      source: Buffer.concat(chunks).toString("utf8"),
    });
  }
  return result;
}

export async function discoverOfficial({
  page: existingPage = null,
  pageUrl = process.env.PARSER_UPDATE_PAGE || "https://live.douyin.com",
  urls = process.env.PARSER_UPDATE_URLS || "",
} = {}) {
  if (urls)
    return fetchOfficialModules(
      typeof urls === "string"
        ? urls
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : urls,
    );
  const u = new URL(pageUrl);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "live.douyin.com" ||
    u.username ||
    u.password ||
    u.port ||
    !/^\/(?:\d+\/?)?$/.test(u.pathname)
  )
    throw new Error("Parser 更新页面必须为官方直播首页或数字房间地址");
  let owned;
  const page =
    existingPage ||
    (await (async () => {
      owned = await chromium.launch({
        executablePath: await browserExecutable(),
        headless: true,
      });
      return owned.newPage();
    })());
  try {
    if (!existingPage) {
      await page.route("**/*", (route) =>
        ["image", "media", "font"].includes(route.request().resourceType())
          ? route.abort()
          : route.continue(),
      );
      await page.goto(u.href, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    await page.waitForFunction(() => self.webpackChunkdouyin_live_v2?.push, {
      timeout: 15000,
    });
    // 借助页面原生 webpack runtime 计算当前哈希 URL；无需写死旧版资源哈希。
    const discovered = await page.evaluate(() => {
      let resources = [];
      self.webpackChunkdouyin_live_v2.push([
        [`parser-observer-${Date.now()}`],
        {},
        (r) => {
          const code = String(r.u);
          const ids = [
            ...code.matchAll(
              /(?:"|')?(\d+)(?:"|')?\s*:\s*["']((?:live-schema|transport-schema)[^"']*)["']/g,
            ),
          ].map((m) => Number(m[1]));
          resources = ids.map(
            (id) => new URL(r.p + r.u(id), location.href).href,
          );
        },
      ]);
      return [...new Set(resources)];
    });
    const im = discovered.filter((s) =>
      /\/(?:live-schema-im|transport-schema-im)\.[\w-]+\.js$/.test(
        new URL(s).pathname,
      ),
    );
    if (
      !im.some((s) => s.includes("live-schema-im")) ||
      !im.some((s) => s.includes("transport-schema-im"))
    )
      throw new Error(
        "官方页面未提供完整 live-schema-im/transport-schema-im；保留当前 Parser",
      );
    return await fetchOfficialModules(im);
  } finally {
    await owned?.close();
  }
}
