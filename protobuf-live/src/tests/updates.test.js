import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadParser } from "../parser.js";
import { diffParsers, ParserUpdater } from "../parser-update.js";
import { readRawPacket, auditRaw, RawSource } from "../raw-source.js";
import { toBarrage } from "../barrage.js";
import { createWorkbench } from "../server.js";

const fixture = (contentId = 3) =>
  `module.exports = {nested:{webcast:{nested:{im:{nested:{PushFrame:{fields:{payload:{id:8,type:'bytes'}}},Response:{fields:{cursor:{id:2,type:'string'}}},ChatMessage:{fields:{content:{id:${contentId},type:'string'},user:{id:2,type:'User'}},nested:{State:{values:{NONE:0,OK:1}}}},User:{fields:{nickname:{id:1,type:'string'},id:{id:2,type:'uint64'}}}}}}}}};`;
async function temp(fn) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "parser-update-")),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("字段编号变更输出旧/新差异，新鲜加载不复用旧缓存", async () =>
  temp(async (dir) => {
    await fs.writeFile(path.join(dir, "official-parser.js"), fixture());
    const old = await loadParser(dir);
    await fs.writeFile(path.join(dir, "official-parser.js"), fixture(9));
    const newer = await loadParser(dir, { fresh: true });
    const d = diffParsers(old, newer);
    assert.equal(d.fields.changed.length, 1);
    assert.equal(d.fields.changed[0].before.id, 3);
    assert.equal(d.fields.changed[0].after.id, 9);
    assert.equal(
      old.types
        .get("webcast.im.ChatMessage")
        .fields.find((f) => f.name === "content").id,
      3,
    );
  }));

test("有效候选可更新，非法候选失败保留旧版和正式产物", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "official-parser.js"), fixture());
    const initial = await loadParser(vendor);
    let source = fixture(9);
    const updater = new ParserUpdater(initial, {
      vendor,
      output: path.join(dir, "output"),
      dist: path.join(dir, "dist"),
      protoDump: path.join(dir, "proto"),
      minCheckMs: 0,
      discover: async () => [
        {
          file: "official-parser.js",
          source,
          url: "https://live.douyin.com/test",
        },
      ],
    });
    const success = await updater.check();
    assert.equal(success.status, "updated");
    assert.equal(
      updater.p.types
        .get("webcast.im.ChatMessage")
        .fields.find((f) => f.name === "content").id,
      9,
    );
    const before = await fs.readFile(path.join(vendor, "official-parser.js"));
    const dict = await fs.readFile(path.join(dir, "dist", "proto.dict"));
    source = "module.exports = {}";
    const failure = await updater.check();
    assert.equal(failure.status, "failed");
    assert.deepEqual(
      await fs.readFile(path.join(vendor, "official-parser.js")),
      before,
    );
    assert.deepEqual(
      await fs.readFile(path.join(dir, "dist", "proto.dict")),
      dict,
    );
    const log = await fs.readFile(
      path.join(dir, "output", "parser-updates.jsonl"),
      "utf8",
    );
    assert.match(log, /"before"/);
    assert.match(log, /"failed"/);
    await updater.close();
  }));

test("更新检查限频持久化，重启仍不重复请求", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "official-parser.js"), fixture());
    const p = await loadParser(vendor);
    let calls = 0;
    const options = {
      vendor,
      output: path.join(dir, "output"),
      discover: async () => {
        calls++;
        throw new Error("测试离线");
      },
    };
    const a = new ParserUpdater(p, options);
    await a.check();
    await a.check();
    await a.close();
    const b = new ParserUpdater(p, options);
    const skipped = await b.check();
    assert.equal(skipped.status, "throttled");
    assert.equal(calls, 1);
    await b.close();
  }));

test("同名 JSON 与文件名中的 uint64 ID 精确保留，只读审计不改动输入", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "official-parser.js"), fixture());
    const p = await loadParser(vendor);
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const name =
      "20261007_120000_001_WebcastChatMessage_18446744073709551615.bin";
    const file = path.join(raw, name);
    await fs.writeFile(
      file,
      p.root
        .lookupType("webcast.im.ChatMessage")
        .encode({ content: "实时弹幕", user: { nickname: "观众" } })
        .finish(),
    );
    await fs.writeFile(
      file.replace(/\.bin$/, ".json"),
      '\uFEFF{"method":"WebcastChatMessage","msg_id":18446744073709551615,"msg_type":0}',
    );
    const before = await fs.stat(file);
    const packet = await readRawPacket(p, file);
    assert.equal(packet.messages[0].msg_id, "18446744073709551615");
    assert.equal(toBarrage(packet.messages[0]).text, "实时弹幕");
    const report = await auditRaw(p, raw, { output: path.join(dir, "audit") });
    assert.equal(report.decoded, 1);
    assert.equal(report.unknown, 0);
    assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
    assert.deepEqual(
      (await fs.readdir(raw)).sort(),
      [name, name.replace(/\.bin$/, ".json")].sort(),
    );
  }));

test("只读监听忽略历史文件，接收新弹幕，截断包稍后完成可重试", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "official-parser.js"), fixture());
    const p = await loadParser(vendor);
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    await fs.writeFile(
      path.join(raw, "old_WebcastChatMessage_1.bin"),
      Buffer.from([0x1a, 0x10]),
    );
    const source = new RawSource(p, { settleMs: 25, retryMs: 30 });
    await source.start({ directory: raw });
    const next = once(source, "packet");
    const file = path.join(raw, "new_WebcastChatMessage_2.bin");
    await fs.writeFile(file, Buffer.from([0x1a, 0x10]));
    await new Promise((r) => setTimeout(r, 75));
    await fs.writeFile(
      file,
      p.root
        .lookupType("webcast.im.ChatMessage")
        .encode({ content: "后续弹幕" })
        .finish(),
    );
    try {
      const packet = await Promise.race([
        next.then(([p]) => p),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error("未收到监听事件")), 4000);
          t.unref();
        }),
      ]);
      assert.equal(packet.messages[0].data.content, "后续弹幕");
    } finally {
      await source.stop();
    }
  }));

test("工作台 raw 输入向独立弹幕 SSE 推送解析结果和精确 ID", async () =>
  temp(async (dir) => {
    const p = await loadParser();
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const app = await createWorkbench(p, {
      port: 0,
      autoUpdate: false,
      updaterOptions: { output: path.join(dir, "state") },
    });
    const abort = new AbortController();
    let reader;
    try {
      const session = await fetch(app.url + "/api/session").then((r) =>
        r.json(),
      );
      const stream = await fetch(app.url + "/api/barrage/events", {
        signal: abort.signal,
      });
      reader = stream.body.getReader();
      const start = await fetch(app.url + "/api/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workbench-token": session.token,
        },
        body: JSON.stringify({ mode: "raw", directory: raw }),
      });
      assert.equal(start.status, 200);
      const chat = p.root.lookupType("webcast.im.ChatMessage");
      const bytes = chat
        .encode(
          chat.fromObject({
            content: "弹幕接口测试",
            user: { nickname: "测试观众", id: "9223372036854775807" },
          }),
        )
        .finish();
      await fs.writeFile(
        path.join(raw, "now_WebcastChatMessage_18446744073709551615.bin"),
        bytes,
      );
      let text = "";
      const until = async () => {
        while (!text.includes("event: barrage")) {
          const { value, done } = await reader.read();
          if (done) throw new Error("弹幕流提前关闭");
          text += Buffer.from(value).toString("utf8");
        }
        return text;
      };
      const output = await Promise.race([
        until(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("弹幕接口超时")), 5000).unref();
        }),
      ]);
      const event = output
        .split("\n\n")
        .find((s) => s.startsWith("event: barrage"));
      const data = JSON.parse(event.split("\ndata: ")[1]);
      assert.equal(data.text, "弹幕接口测试");
      assert.equal(data.user.nickname, "测试观众");
      assert.equal(data.user.id, "9223372036854775807");
      assert.equal(data.message_id, "18446744073709551615");
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => {});
      await app.close();
    }
  }));

test("文件重复通知在排队期间到达，不得重复输出同一消息", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "official-parser.js"), fixture());
    const p = await loadParser(vendor);
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const source = new RawSource(p, { settleMs: 10 });
    let count = 0;
    source.on("packet", () => count++);
    await source.start({ directory: raw });
    let release;
    source.queue = new Promise((r) => {
      release = r;
    });
    const name = "new_WebcastChatMessage_2.bin";
    try {
      await fs.writeFile(
        path.join(raw, name),
        p.root
          .lookupType("webcast.im.ChatMessage")
          .encode({ content: "只有一条" })
          .finish(),
      );
      await new Promise((r) => setTimeout(r, 40));
      source.enqueue(name, source.generation);
      await new Promise((r) => setTimeout(r, 40));
      release();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(count, 1);
    } finally {
      release();
      await source.stop();
    }
  }));

test("缺失的未知裸副作用模块必须拒绝，不能视为空扩展", async () =>
  temp(async (dir) => {
    await fs.writeFile(
      path.join(dir, "live-schema-im.test.js"),
      `self.webpackChunkdouyin_live_v2.push([[1],{1:function(m,e,r){r(999999);}}]);`,
    );
    await assert.rejects(loadParser(dir), /依赖 999999/);
  }));

test("输出路径通过链接进入只读目录时，在 mkdir 之前拒绝", async () =>
  temp(async (dir) => {
    const raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const linked = path.join(dir, "linked");
    await fs.symlink(
      raw,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      auditRaw({}, raw, { output: path.join(linked, "new-output") }),
      /只读/,
    );
    await assert.rejects(
      fs.stat(path.join(raw, "new-output")),
      (e) => e.code === "ENOENT",
    );
  }));

test("激活失败恢复官方文件、两类成品及内存 Parser", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    const file = path.join(vendor, "official-parser.js");
    await fs.writeFile(file, fixture());
    const p = await loadParser(vendor);
    const updater = new ParserUpdater(p, {
      vendor,
      output: path.join(dir, "output"),
      dist: path.join(dir, "dist"),
      protoDump: path.join(dir, "proto"),
      minCheckMs: 0,
      discover: async () => [
        { file: "official-parser.js", source: fixture(9) },
      ],
      activate: async (next) => {
        if (
          next.types
            .get("webcast.im.ChatMessage")
            .fields.find((f) => f.name === "content").id === 9
        )
          throw new Error("激活失败测试");
      },
    });
    const result = await updater.check();
    assert.equal(result.status, "failed");
    assert.equal(updater.p, p);
    assert.equal(await fs.readFile(file, "utf8"), fixture());
    await assert.rejects(
      fs.stat(path.join(dir, "dist", "proto.dict")),
      (e) => e.code === "ENOENT",
    );
    await assert.rejects(
      fs.stat(path.join(dir, "proto", "live_debug_snapshot.proto")),
      (e) => e.code === "ENOENT",
    );
    await updater.close();
  }));

test("更新提交等待共享产物串行锁，不能覆盖尚在保存的旧产物", async () =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    const file = path.join(vendor, "official-parser.js");
    await fs.writeFile(file, fixture());
    const p = await loadParser(vendor);
    let release, enteredResolve;
    const held = new Promise((r) => {
        release = r;
      }),
      entered = new Promise((r) => {
        enteredResolve = r;
      });
    const updater = new ParserUpdater(p, {
      vendor,
      output: path.join(dir, "output"),
      dist: path.join(dir, "dist"),
      protoDump: path.join(dir, "proto"),
      minCheckMs: 0,
      discover: async () => [
        { file: "official-parser.js", source: fixture(9) },
      ],
      withCommit: async (job) => {
        enteredResolve();
        await held;
        return job();
      },
    });
    try {
      const task = updater.check();
      await entered;
      assert.equal(await fs.readFile(file, "utf8"), fixture());
      release();
      const result = await task;
      assert.equal(result.status, "updated");
      const dictionary = JSON.parse(
        await fs.readFile(path.join(dir, "dist", "proto.dict"), "utf8"),
      );
      assert.equal(
        dictionary["webcast.im.ChatMessage"].fields.find(
          (f) => f.field_name === "content",
        ).field_number,
        9,
      );
    } finally {
      release();
      await updater.close();
    }
  }));

test("定时器到期实际执行官方检查，版本未变仍生成双产物", async (t) =>
  temp(async (dir) => {
    const vendor = path.join(dir, "vendor");
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "official-parser.js"), fixture());
    const p = await loadParser(vendor);
    let checks = 0;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const updater = new ParserUpdater(p, {
      vendor,
      output: path.join(dir, "output"),
      dist: path.join(dir, "dist"),
      protoDump: path.join(dir, "proto"),
      intervalMs: 3600000,
      discover: async () => {
        checks++;
        return [{ file: "official-parser.js", source: fixture() }];
      },
    });
    try {
      await updater.schedule();
      assert.equal(checks, 0);
      t.mock.timers.tick(3600000);
      await updater.running;
      assert.equal(checks, 1);
      assert.equal(updater.status.status, "unchanged");
      assert.ok((await fs.stat(path.join(dir, "dist", "proto.dict"))).size > 0);
      assert.ok(
        (await fs.stat(path.join(dir, "proto", "live_debug_snapshot.proto")))
          .size > 0,
      );
    } finally {
      await updater.close();
      t.mock.timers.reset();
    }
  }));
