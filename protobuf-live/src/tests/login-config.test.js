import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { LoginConfig, createLoginContext } from "../login-config.js";
import { browserExecutable } from "../parser-discovery.js";
import { createWorkbench } from "../server.js";
import { loadParser } from "../parser.js";

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webcast-login-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("保存真实浏览器登录态，仅保留抖音来源，重新启动后恢复且不向页面泄露 Cookie", async (t) => {
  let executablePath;
  try {
    executablePath = await browserExecutable();
  } catch {
    t.skip("登录态验收需要本机 Chrome/Edge");
    return;
  }
  const dir = await temp(t);
  await fs.writeFile(
    path.join(dir, ".env"),
    "PORT=8787\nDOUYIN_COOKIE='old=test'\nRAW_PROTO_DIR=D:\\samples\n",
  );
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    storageState: {
      cookies: [
        {
          name: "sessionid",
          value: "fake-test-session=a",
          domain: ".douyin.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
        {
          name: "other",
          value: "unrelated",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://live.douyin.com",
          localStorage: [{ name: "test-state", value: "fake-state" }],
        },
        {
          origin: "https://example.com",
          localStorage: [{ name: "unrelated", value: "private" }],
        },
      ],
    },
  });
  const config = new LoginConfig({ directory: dir, fallbackCookie: "" });
  const meta = await config.save(context);
  assert.equal(meta.configured, true);
  assert.equal(meta.browser_state, true);
  assert.equal(JSON.stringify(meta).includes("fake-test-session"), false);
  const env = await fs.readFile(path.join(dir, ".env"), "utf8");
  assert.match(env, /PORT=8787/);
  assert.match(env, /RAW_PROTO_DIR=D:\\samples/);
  assert.equal(env.includes("old=test"), false);
  const login = await new LoginConfig({
    directory: dir,
    fallbackCookie: "stale=env",
  }).load();
  assert.equal(login.cookie, "sessionid=fake-test-session=a");
  assert.equal(login.storageState.cookies.length, 1);
  assert.equal(login.storageState.origins.length, 1);
  const restored = await createLoginContext(browser, login);
  const cookies = await restored.cookies("https://live.douyin.com");
  assert.equal(cookies[0].value, "fake-test-session=a");
  assert.equal(cookies[0].httpOnly, true);
  assert.deepEqual(
    (await restored.storageState()).origins,
    login.storageState.origins,
  );
  await fs.writeFile(
    path.join(dir, ".env"),
    "DOUYIN_COOKIE='manually=changed'\n",
  );
  const changed = await config.load();
  assert.equal(changed.cookie, "manually=changed");
  assert.equal(changed.storageState, undefined);
  assert.equal((await config.metadata()).browser_state, false);
  const manual = await createLoginContext(browser, changed);
  assert.deepEqual(
    (await manual.cookies("https://live.douyin.com")).map((c) => c.name),
    ["manually"],
  );
  await manual.close();
  await context.close();
  await restored.close();
});
test("每次连接重新读取配置：手动 Cookie 修改或清空后，不复用旧登录态", async (t) => {
  const dir = await temp(t);
  const config = new LoginConfig({
    directory: dir,
    fallbackCookie: "stale=process",
  });
  await fs.writeFile(
    path.join(dir, ".env"),
    "DOUYIN_COOKIE='fresh=value=1; second=x'\n",
  );
  assert.equal((await config.load()).cookie, "fresh=value=1; second=x");
  await fs.writeFile(path.join(dir, ".env"), "DOUYIN_COOKIE=\n");
  assert.equal((await config.load()).cookie, "");
  await fs.writeFile(path.join(dir, ".env"), "DOUYIN_COOKIE='changed=now'\n");
  assert.equal((await config.load()).cookie, "changed=now");
  await fs.mkdir(path.join(dir, ".browser-profile"));
  await fs.writeFile(
    path.join(dir, ".browser-profile", "login-state.json"),
    "{broken",
  );
  assert.equal((await config.metadata()).configured, true);
});
test("浏览器保存过程中 Cookie 刷新仍保持一致快照，配置替换失败恢复旧状态", async (t) => {
  let executablePath;
  try {
    executablePath = await browserExecutable();
  } catch {
    t.skip("登录态验收需要本机 Chrome/Edge");
    return;
  }
  const dir = await temp(t);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const cookie = {
    name: "sessionid",
    value: "fake-old",
    domain: ".douyin.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  };
  await context.addCookies([cookie]);
  const config = new LoginConfig({ directory: dir, fallbackCookie: "" });
  const snapshot = context.storageState.bind(context);
  // 浏览器在快照完成后刷新 Cookie，模拟登录续期与用户点击保存同时发生。
  const snapshotMock = t.mock.method(context, "storageState", async () => {
    const state = await snapshot();
    await context.addCookies([{ ...cookie, value: "fake-new" }]);
    return state;
  });
  await config.save(context);
  snapshotMock.mock.restore();
  const loaded = await config.load();
  assert.equal(
    loaded.cookie,
    "sessionid=" + loaded.storageState.cookies[0].value,
  );
  assert.equal(loaded.cookie, "sessionid=fake-old");
  const beforeEnv = await fs.readFile(config.envFile, "utf8");
  const beforeState = await fs.readFile(config.stateFile, "utf8");
  const rename = fs.rename.bind(fs);
  const renameMock = t.mock.method(fs, "rename", async (from, to) => {
    if (to === config.envFile)
      throw Object.assign(new Error("模拟配置文件锁定"), { code: "EACCES" });
    return rename(from, to);
  });
  await assert.rejects(config.save(context), /保存失败/);
  renameMock.mock.restore();
  assert.equal(await fs.readFile(config.envFile, "utf8"), beforeEnv);
  assert.equal(await fs.readFile(config.stateFile, "utf8"), beforeState);
  assert.equal((await config.load()).storageState.cookies[0].value, "fake-old");
  assert.deepEqual(
    (await fs.readdir(path.dirname(config.stateFile))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );
  await context.close();
});
test("保存登录态接口要求工作台令牌，并拒绝在未开启浏览器时保存", async (t) => {
  const dir = await temp(t);
  const app = await createWorkbench(await loadParser(), {
    port: 0,
    autoUpdate: false,
    updaterOptions: { output: path.join(dir, "updater") },
    loginOptions: { directory: dir, fallbackCookie: "fake-secret=hidden" },
  });
  t.after(() => app.close());
  const session = await (await fetch(app.url + "/api/session")).json();
  assert.equal(session.login.configured, true);
  assert.equal(JSON.stringify(session).includes("fake-secret"), false);
  let response = await fetch(app.url + "/api/save-login", { method: "POST" });
  assert.equal(response.status, 403);
  response = await fetch(app.url + "/api/save-login", {
    method: "POST",
    headers: { "x-workbench-token": session.token },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /浏览器/);
  assert.equal(
    (await fetch(app.url + "/.browser-profile/login-state.json")).status,
    404,
  );
  assert.equal((await fetch(app.url + "/.env")).status, 404);
});
test("工作台保存按钮将浏览器 Cookie 写入本地配置，服务重启后恢复登录态", async (t) => {
  let executablePath;
  try {
    executablePath = await browserExecutable();
  } catch {
    t.skip("登录工作台验收需要本机 Chrome/Edge");
    return;
  }
  const dir = await temp(t);
  const launch = chromium.launch.bind(chromium);
  const driver = await launch({ executablePath, headless: true });
  t.after(() => driver.close());
  let liveContext;
  // 使用真实浏览器，仅替换直播页面的网络响应，避免请求公网或使用真实凭据。
  t.mock.method(chromium, "launch", async (options) => {
    const liveBrowser = await launch(options);
    const newContext = liveBrowser.newContext.bind(liveBrowser);
    t.mock.method(liveBrowser, "newContext", async (config) => {
      const context = await newContext(config);
      liveContext = context;
      await context.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<html><body>本地登录测试</body></html>",
        }),
      );
      if (!config.storageState)
        await context.addCookies([
          {
            name: "sessionid",
            value: "fake-workbench-login",
            domain: ".douyin.com",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
      return context;
    });
    return liveBrowser;
  });
  const p = await loadParser();
  const options = {
    port: 0,
    autoUpdate: false,
    updaterOptions: { output: path.join(dir, "updater") },
    loginOptions: { directory: dir, fallbackCookie: "" },
  };
  let app = await createWorkbench(p, options);
  t.after(() => app.close());
  const page = await driver.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function start() {
    await page.goto(app.url);
    await page.waitForFunction(
      () => document.querySelector("#type-list").children.length > 0,
    );
    await page.fill("#target", "https://live.douyin.com/100");
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/start"),
    );
    await page.click("#start");
    assert.equal((await response).status(), 200);
  }
  await start();
  await page.click("#save-login");
  await page.waitForFunction(() =>
    document
      .querySelector("#login-status")
      .textContent.startsWith("已保存登录态"),
  );
  assert.equal(
    (await new LoginConfig(options.loginOptions).load()).cookie,
    "sessionid=fake-workbench-login",
  );
  const session = await (await fetch(app.url + "/api/session")).json();
  assert.equal(session.login.browser_state, true);
  assert.equal(JSON.stringify(session).includes("fake-workbench-login"), false);
  assert.equal(
    (await page.locator("body").innerText()).includes("fake-workbench-login"),
    false,
  );
  await app.close();
  app = await createWorkbench(p, options);
  await start();
  assert.equal(
    (await liveContext.cookies("https://live.douyin.com"))[0].value,
    "fake-workbench-login",
  );
  assert.match(await page.locator("#login-status").innerText(), /已保存登录态/);
  assert.deepEqual(errors, []);
});
