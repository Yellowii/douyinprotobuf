import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadParser } from "../parser.js";
import { RawBatch } from "../raw-batch.js";
import { createWorkbench } from "../server.js";
import { writeArtifacts, validateArtifacts } from "../dictionary.js";
import { paths } from "../paths.js";

async function temp(fn) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "raw-batch-")),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function samples(p, raw) {
  await fs.mkdir(raw);
  const chat = p.root.lookupType("webcast.im.ChatMessage");
  await fs.writeFile(
    path.join(raw, "a_WebcastChatMessage_18446744073709551615.bin"),
    chat
      .encode(
        chat.fromObject({
          content: "已有文件弹幕",
          user: { nickname: "批量验收" },
        }),
      )
      .finish(),
  );
  await fs.writeFile(
    path.join(raw, "b_WebcastNoOfficialDefinition_2.bin"),
    Buffer.from([8, 1]),
  );
  await fs.writeFile(
    path.join(raw, "c_WebcastChatMessage_3.bin"),
    Buffer.from([0x1a, 0x10]),
  );
  return (await fs.readdir(raw)).sort();
}
async function until(fn) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("批量任务等待超时");
}

test("批量模式解析历史包、隔离未知/失败，保存完整 JSON 并只读源目录", async () =>
  temp(async (dir) => {
    const p = await loadParser(),
      raw = path.join(dir, "raw");
    const before = await samples(p, raw);
    const source = new RawBatch(p, {
      output: path.join(dir, "results"),
      previewMs: 10,
    });
    const previews = [];
    source.on("packet", (p) => previews.push(p));
    await source.start({ directory: raw });
    await source.task;
    assert.equal(source.status.state, "completed");
    assert.equal(source.status.total, 3);
    assert.equal(source.status.processed, 3);
    assert.equal(source.status.decoded, 1);
    assert.equal(source.status.failed, 1);
    assert.equal(source.status.unknown, 1);
    const lines = (
      await fs.readFile(
        path.join(source.status.output, "raw-audit.events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(lines.length, 3);
    assert.ok(
      lines.some((p) => p.messages[0].data?.content === "已有文件弹幕"),
    );
    assert.ok(
      previews.some((p) =>
        p.messages.some((m) => m.msg_id === "18446744073709551615"),
      ),
    );
    assert.deepEqual((await fs.readdir(raw)).sort(), before);
    await source.stop();
  }));

test("工作台前端连接 API 可启动历史批量任务，状态刷新与报告可恢复", async () =>
  temp(async (dir) => {
    const p = await loadParser(),
      raw = path.join(dir, "raw");
    await samples(p, raw);
    const app = await createWorkbench(p, {
      port: 0,
      autoUpdate: false,
      batchOutput: path.join(dir, "results"),
      updaterOptions: { output: path.join(dir, "state") },
    });
    try {
      const session = await fetch(app.url + "/api/session").then((r) =>
        r.json(),
      );
      const body = JSON.stringify({ mode: "raw-batch", directory: raw });
      assert.equal(
        (
          await fetch(app.url + "/api/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
        ).status,
        403,
      );
      const response = await fetch(app.url + "/api/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workbench-token": session.token,
        },
        body,
      });
      assert.equal(response.status, 200);
      const result = await until(async () => {
        const s = await fetch(app.url + "/api/session").then((r) => r.json());
        return s.batch?.state === "completed" ? s : false;
      });
      assert.equal(result.batch.processed, 3);
      assert.equal(result.batch.failed, 1);
      assert.equal(result.batch.unknown, 1);
      const report = await fetch(app.url + "/api/batch-report").then((r) =>
        r.json(),
      );
      assert.equal(report.packets, 3);
      assert.equal(report.decoded, 1);
    } finally {
      await app.close();
    }
  }));

test("停止批量任务能中止后续读取并保存部分结果", async () =>
  temp(async (dir) => {
    const p = await loadParser(),
      raw = path.join(dir, "raw");
    await fs.mkdir(raw);
    const chat = p.root.lookupType("webcast.im.ChatMessage");
    const bytes = chat.encode({ content: "取消测试" }).finish();
    for (let i = 0; i < 200; i++)
      await fs.writeFile(
        path.join(raw, `${i}_WebcastChatMessage_${i + 1}.bin`),
        bytes,
      );
    const source = new RawBatch(p, { output: path.join(dir, "results") });
    let requested = false;
    source.on("status", (s) => {
      if (s.state === "running" && s.processed > 0 && !requested) {
        requested = true;
        source.stop();
      }
    });
    await source.start({ directory: raw });
    await source.task;
    assert.equal(requested, true);
    assert.equal(source.status.state, "cancelled");
    assert.ok(source.status.processed < 200);
    assert.equal(source.status.total, 200);
    assert.equal(source.report.cancelled, true);
  }));

test("多个工作台同时生成产物不共享临时文件，成品仍可完整读取", async () => {
  const p = await loadParser();
  await Promise.all(Array.from({ length: 4 }, () => writeArtifacts(p)));
  const dictionary = JSON.parse(
    await fs.readFile(path.join(paths.dist, "proto.dict"), "utf8"),
  );
  const proto = await fs.readFile(
    path.join(paths.proto_dump, "live_debug_snapshot.proto"),
    "utf8",
  );
  assert.equal(
    validateArtifacts(p, { dictionary, proto }).messages,
    p.types.size,
  );
});
