import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { loadParser } from "../parser.js";
import { createWorkbench } from "../server.js";
import { browserExecutable } from "../parser-discovery.js";
import { decodeBusiness } from "../decode.js";

// 此测试捕获展示适配器丢失真实消息、礼物计数、样式隔离或误暂停解析链路的回归。
test("展示插件通过真实 raw 消息更新弹幕与礼物，暂停预览不影响解析且样式独立", async (t) => {
  let executablePath;
  try {
    executablePath = await browserExecutable();
  } catch {
    t.skip("前端验收需要本机 Chrome/Edge");
    return;
  }
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "workbench-plugins-")),
  );
  const p = await loadParser();
  const app = await createWorkbench(p, {
    port: 0,
    autoUpdate: false,
    updaterOptions: { output: path.join(dir, "updater") },
  });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.url);
    await page.waitForFunction(
      () => document.querySelector("#type-list").children.length > 0,
    );
    assert.equal(
      await page.locator("#plugin-preview").count(),
      1,
      "工作台应提供可使用的弹幕和礼物展示区域",
    );
    await page.selectOption("#mode", "raw");
    await page.fill("#target", raw);
    await page.click("#start");
    await page.waitForFunction(
      () => document.querySelector("#connection").textContent === "已连接",
    );
    const chat = p.root.lookupType("webcast.im.ChatMessage");
    const gift = p.root.lookupType("webcast.im.GiftMessage");
    const chatBytes = (content) =>
      chat
        .encode(chat.fromObject({ content, user: { nickname: "测试观众" } }))
        .finish();
    const writeChat = (id, content) =>
      fs.writeFile(
        path.join(raw, `t_WebcastChatMessage_${id}.bin`),
        chatBytes(content),
      );
    const writeGift = (id, count) =>
      fs.writeFile(
        path.join(raw, `t_WebcastGiftMessage_${id}.bin`),
        gift
          .encode(
            gift.fromObject({
              user: { id: "99", nickname: "送礼观众" },
              gift: { id: "42", name: "测试礼物" },
              gift_id: "42",
              group_id: "9223372036854775807",
              repeat_count: count,
            }),
          )
          .finish(),
      );
    await writeChat(1, "<img src=x onerror=alert(1)>弹幕内容");
    const stage = page.locator("#plugin-preview");
    await stage.locator(".danmaku-line").first().waitFor();
    assert.match(
      await stage.locator(".danmaku-line").first().innerText(),
      /弹幕内容/,
    );
    assert.equal(await stage.locator(".danmaku-line img").count(), 0);
    await writeGift(2, 3);
    await stage.locator(".gift-card").waitFor();
    assert.match(await stage.locator(".gift-card").innerText(), /测试礼物/);
    await writeGift(3, 5);
    await page.waitForFunction(() =>
      document
        .querySelector("#plugin-preview")
        .shadowRoot.querySelector(".gift-count")
        ?.textContent.includes("5"),
    );
    assert.equal(await stage.locator(".gift-card").count(), 1);
    const styles = await stage
      .locator(".danmaku-line")
      .first()
      .evaluate((e) => ({
        color: getComputedStyle(e).color,
        textShadow: getComputedStyle(e).textShadow,
      }));
    assert.equal(styles.color, "rgb(255, 255, 255)");
    assert.notEqual(styles.textShadow, "none");
    assert.equal(
      await page.locator("h1").evaluate((e) => getComputedStyle(e).color),
      "rgb(23, 33, 55)",
    );
    await page.click("#preview-pause");
    const previewCount = await stage.locator(".danmaku-line").count();
    await writeChat(4, "暂停时仍然解析");
    await page.waitForFunction(
      () => document.querySelector("#message-count").textContent === "4",
    );
    assert.equal(await stage.locator(".danmaku-line").count(), previewCount);
    assert.match(await page.locator("#feed").innerText(), /暂停时仍然解析/);
    // 暂停期间改变窗口宽度，现有弹幕仍应留在可见预览区域。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#plugin-preview").shadowRoot;
        const stage = root.querySelector(".stage").getBoundingClientRect();
        return [...root.querySelectorAll(".danmaku-line")].some((line) => {
          const rect = line.getBoundingClientRect();
          return rect.left < stage.right && rect.right > stage.left;
        });
      },
      null,
      { timeout: 2000 },
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    // 暂停期间检查可访问交互，避免把动画自然结束当作点击功能失败。
    await stage.locator(".danmaku-line").first().focus();
    await page.keyboard.press("Enter");
    assert.match(await page.locator("#detail").innerText(), /弹幕内容/);
    await page.click("#preview-pause");
    await page.selectOption("#preview-font", "24");
    await page.selectOption("#preview-speed", "fast");
    await page.click("#preview-gifts");
    assert.equal(await stage.locator(".gift-card:visible").count(), 0);
    await page.click("#preview-gifts");
    await page.click("#preview-fullscreen");
    await page.waitForFunction(
      () => document.fullscreenElement?.id === "preview-panel",
    );
    await page.evaluate(() => document.exitFullscreen());
    await page.click("#preview-clear");
    assert.equal(await stage.locator(".danmaku-line").count(), 0);
    assert.equal(await stage.locator(".gift-card").count(), 0);
    assert.equal(await page.locator("#message-count").innerText(), "4");
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector("#type-list").children.length > 0,
    );
    assert.equal(await page.locator("#preview-font").inputValue(), "24");
    assert.equal(await page.locator("#preview-speed").inputValue(), "fast");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const limits = await page.evaluate(() => {
      const preview = document.querySelector("#plugin-preview");
      preview.clear();
      for (let i = 0; i < 200; i++) {
        preview.barrage(
          { user: { nickname: "队列验收" }, text: `弹幕 ${i}` },
          { method: "WebcastChatMessage" },
        );
        preview.gift({
          method: "WebcastGiftMessage",
          status: "decoded",
          msg_id: String(i + 1),
          data: {
            user: { nickname: "队列验收" },
            gift: { name: "测试礼物" },
            repeat_count: "1",
          },
        });
      }
      return {
        lines: preview.lines.children.length,
        gifts: preview.gifts.size,
      };
    });
    assert.deepEqual(limits, { lines: 40, gifts: 3 });
    await page.click("#stop");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function withBrowserWorkbench(fn, t) {
  let executablePath;
  try {
    executablePath = await browserExecutable();
  } catch {
    t.skip("前端验收需要本机 Chrome/Edge");
    return;
  }
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "preview-regression-")),
  );
  const p = await loadParser();
  const app = await createWorkbench(p, {
    port: 0,
    autoUpdate: false,
    updaterOptions: { output: path.join(dir, "updater") },
    batchOutput: path.join(dir, "batch"),
  });
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(app.url);
    await page.waitForFunction(
      () => document.querySelector("#type-list").children.length > 0,
    );
    await fn({ p, page, dir });
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("官方嵌套礼物与默认零计数字段正确展示，累计数量不相加并保留 64 位精度", async (t) =>
  withBrowserWorkbench(async ({ p, page }) => {
    const gift = p.root.lookupType("webcast.im.GiftMessage"),
      binding = p.root.lookupType("webcast.im.BindingGiftMessage");
    const data = {
      user: { id: "99", nickname: "绑定用户" },
      gift: { id: "42", name: "绑定礼物" },
      gift_id: "42",
      group_id: "9223372036854775807",
      repeat_count: "5",
    };
    const packet = {
      kind: "business",
      messages: [
        {
          ...decodeBusiness(
            p,
            "WebcastBindingGiftMessage",
            binding.encode(binding.fromObject({ msg: data })).finish(),
          ),
          msg_id: "1",
        },
      ],
    };
    await page.evaluate(
      (packet) => document.querySelector("#plugin-preview").packet(packet),
      packet,
    );
    const tray = page.locator("#plugin-preview .gift-card");
    assert.match(await tray.innerText(), /绑定用户/);
    assert.match(await tray.innerText(), /绑定礼物/);
    assert.equal(await tray.locator(".gift-count").innerText(), "5");
    const combo = {
      kind: "business",
      messages: [
        {
          ...decodeBusiness(
            p,
            "WebcastGiftMessage",
            gift
              .encode(
                gift.fromObject({
                  ...data,
                  repeat_count: "0",
                  combo_count: "9007199254740993",
                }),
              )
              .finish(),
          ),
          msg_id: "2",
        },
      ],
    };
    await page.evaluate(
      (packet) => document.querySelector("#plugin-preview").packet(packet),
      combo,
    );
    assert.equal(await tray.count(), 1);
    assert.equal(
      await tray.locator(".gift-count").innerText(),
      "9007199254740993",
    );
    // 同一组晚到的小计数或重复通知都不能回退/相加。
    const stale = {
      kind: "business",
      messages: [
        {
          ...decodeBusiness(
            p,
            "WebcastGiftMessage",
            gift.encode(gift.fromObject(data)).finish(),
          ),
          msg_id: "3",
        },
      ],
    };
    await page.evaluate(
      (packet) => document.querySelector("#plugin-preview").packet(packet),
      stale,
    );
    await page.evaluate(
      (packet) => document.querySelector("#plugin-preview").packet(packet),
      combo,
    );
    assert.equal(
      await tray.locator(".gift-count").innerText(),
      "9007199254740993",
    );
    // 信封默认 ID=0 时应使用实际 common.msg_id，不能把不同礼物当重复包。
    await page.click("#preview-clear");
    for (const id of ["9007199254740993", "9007199254740994"]) {
      const packet = {
        kind: "business",
        messages: [
          {
            ...decodeBusiness(
              p,
              "WebcastGiftMessage",
              gift
                .encode(
                  gift.fromObject({
                    ...data,
                    group_id: "0",
                    common: { msg_id: id },
                  }),
                )
                .finish(),
            ),
            msg_id: "0",
          },
        ],
      };
      await page.evaluate(
        (packet) => document.querySelector("#plugin-preview").packet(packet),
        packet,
      );
    }
    assert.equal(await tray.count(), 2);
  }, t));

test("同目录重新批量解析使用新的展示作用域，礼物不被上一任务去重记录屏蔽", async (t) =>
  withBrowserWorkbench(async ({ p, page, dir }) => {
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const gift = p.root.lookupType("webcast.im.GiftMessage");
    await fs.writeFile(
      path.join(raw, "t_WebcastGiftMessage_88.bin"),
      gift
        .encode(
          gift.fromObject({
            user: { nickname: "重复批量验收" },
            gift: { id: "42", name: "再次出现" },
            gift_id: "42",
            repeat_count: "2",
          }),
        )
        .finish(),
    );
    await page.selectOption("#mode", "raw-batch");
    await page.fill("#target", raw);
    for (let i = 0; i < 2; i++) {
      await page.click("#start");
      await page.waitForFunction(
        () =>
          document.querySelector("#batch-state").textContent === "解析完成" &&
          !document.querySelector("#start").disabled,
      );
      assert.equal(await page.locator("#plugin-preview .gift-card").count(), 1);
      assert.match(
        await page.locator("#plugin-preview .gift-card").innerText(),
        /再次出现/,
      );
      if (!i) {
        // 模拟礼物自然到期，不清空去重记录，再通过表单启动新任务。
        await page.evaluate(() => {
          const preview = document.querySelector("#plugin-preview");
          for (const gift of preview.gifts.values()) gift.expires = 0;
          preview.sweep();
        });
        assert.equal(
          await page.locator("#plugin-preview .gift-card").count(),
          0,
        );
      }
    }
  }, t));
