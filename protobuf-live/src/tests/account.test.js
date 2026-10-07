import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserExecutable } from "../parser-discovery.js";
import { AccountMonitor, normalizeAccount } from "../account.js";

test("账号识别只接受官方当前用户响应，精确保留 ID 并过滤凭据与不安全头像", () => {
  const result = normalizeAccount(
    {
      status_code: 0,
      data: {
        id_str: "9007199254740993",
        nickname: "测试用户",
        display_id: "tester",
        avatar_thumb: { url_list: ["https://p3.douyinpic.com/test.png"] },
        sessionid: "must-not-leak",
      },
    },
    "/webcast/user/me/",
  );
  assert.equal(result.state, "authenticated");
  assert.equal(
    normalizeAccount(
      JSON.stringify({
        status_code: 0,
        data: { id_str: "123", nickname: "字符串响应" },
      }),
      "/webcast/user/me/",
    ).state,
    "authenticated",
  );
  assert.equal(
    normalizeAccount("<html>verification</html>", "/webcast/user/me/").state,
    "error",
  );
  assert.equal(result.user.id, "9007199254740993");
  assert.equal(result.user.nickname, "测试用户");
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(
    normalizeAccount({ status_code: 0, data: {} }, "/webcast/user/me/").state,
    "anonymous",
  );
  assert.equal(
    normalizeAccount({ status_code: 8 }, "/aweme/v1/web/user/profile/self/")
      .state,
    "anonymous",
  );
  assert.equal(
    normalizeAccount({ status_code: 500 }, "/webcast/user/me/").state,
    "error",
  );
  assert.equal(
    normalizeAccount(
      { status_code: 0, data: { id_str: "42" } },
      "/webcast/user/profile/",
    ).state,
    "unknown",
  );
  assert.equal(
    normalizeAccount(
      {
        status_code: 0,
        data: {
          id_str: "42",
          avatar_thumb: { url_list: ["https://evil.example/avatar.png"] },
        },
      },
      "/webcast/user/me/",
    ).user.avatar,
    "",
  );
});

test("真实浏览器账号监测复用官方 SDK 查询、限频、访客转登录和关闭清理", async (t) => {
  let executablePath;
  try {
    executablePath = await browserExecutable();
  } catch {
    t.skip("需要 Chrome/Edge");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto("https://live.douyin.com/100");
  await page.evaluate(() => {
    window.calls = 0;
    window.reply = { status_code: 0, data: {} };
    window.webpackChunkdouyin_live_v2 = [
      [[], { "fake-sdk": () => "/webcast/user/me/" }],
    ];
    const append = window.webpackChunkdouyin_live_v2.push.bind(
      window.webpackChunkdouyin_live_v2,
    );
    window.webpackChunkdouyin_live_v2.push = (entry) => {
      if (entry[2])
        entry[2](() => ({
          current: async () => {
            const endpoint = "/webcast/user/me/";
            window.calls++;
            if (window.pauseQuery)
              return new Promise((resolve) => {
                window.resumeQuery = resolve;
              });
            return { data: window.reply, endpoint };
          },
        }));
      return append(entry);
    };
  });
  const monitor = new AccountMonitor();
  monitor.attach(page, { schedule: false });
  assert.equal((await monitor.check()).state, "anonymous");
  await monitor.check();
  assert.equal(await page.evaluate(() => window.calls), 1);
  // 官方页面主动产生账号响应时应立即生效，不受额外查询冷却影响。
  await monitor.accept(
    { status_code: 0, data: { id_str: "123", nickname: "刚登录用户" } },
    "/webcast/user/me/",
  );
  assert.equal(monitor.status.state, "authenticated");
  await page.evaluate(() => {
    window.reply = { status_code: 0, data: {} };
  });
  const fresh = monitor.confirmForSave();
  await assert.rejects(fresh, /旧配置已保留/, "保存不能复用冷却前的已登录缓存");
  assert.equal(await page.evaluate(() => window.calls), 2);
  await monitor.accept({ status_code: 0, data: {} }, "/webcast/user/me/");
  assert.equal(monitor.status.state, "anonymous");
  await page.evaluate(() => {
    window.pauseQuery = true;
  });
  monitor.lastQuery = 0;
  const pending = monitor.check();
  await page.waitForFunction(() => typeof window.resumeQuery === "function");
  const saving = monitor.confirmForSave();
  const rejected = assert.rejects(saving, /旧配置已保留/);
  monitor.stop();
  await page.evaluate(() => window.resumeQuery({ data: window.reply }));
  await pending;
  await rejected;
  assert.equal(monitor.status.state, "inactive");
  assert.equal((await monitor.check()).state, "inactive");
});
