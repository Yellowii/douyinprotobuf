import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { loadParser } from "../parser.js";
import { extractHar, parseRawDirectory } from "../offline.js";
import { decodePacket, MAX_PACKET } from "../decode.js";
import { importParsers } from "../har.js";

test("HAR 只抽取 receive opcode2、严格 base64、坏包隔离", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webcast-"));
  try {
    const har = path.join(dir, "test.har"),
      raw = path.join(dir, "raw");
    const failures = [];
    await fs.writeFile(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              request: { url: "wss://example.invalid/" },
              _webSocketMessages: [
                { type: "send", opcode: 2, data: "AQ==" },
                { type: "receive", opcode: 1, data: "AQ==" },
                { type: "receive", opcode: 2, data: "AQ==" },
                { type: "receive", opcode: 2, data: "not-base64!" },
              ],
            },
          ],
        },
      }),
    );
    const stats = await extractHar(har, raw, (e) => failures.push(e));
    assert.equal(stats.extracted, 1);
    assert.equal(failures.length, 1);
    await fs.writeFile(path.join(raw, "broken.bin"), Buffer.from([255]));
    const p = await loadParser(),
      events = [];
    const report = await parseRawDirectory(p, raw, {
      event: (e) => events.push(e),
      failure: (e) => failures.push(e),
    });
    assert.equal(report.failed, 2);
    assert.equal(report.packets, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("gzip 下行正确解码 ACK 和现代传输心跳", async () => {
  const p = await loadParser();
  const chat = p.root.lookupType("webcast.im.ChatMessage");
  const payload = chat
    .encode(chat.fromObject({ content: "gzip 弹幕" }))
    .finish();
  const resp = p.types
    .get("webcast.im.Response")
    .original.encode({
      messages: [
        {
          method: "WebcastChatMessage",
          payload,
          msg_id: "9223372036854775806",
        },
      ],
      need_ack: true,
      internal_ext: "cursor-context",
    })
    .finish();
  const frame = p.types
    .get("webcast.im.PushFrame")
    .original.encode({
      SeqID: "123",
      LogID: "456",
      payload_type: "msg",
      headers: [{ key: "compress_type", value: "gzip" }],
      payload: zlib.gzipSync(resp),
    })
    .finish();
  const r = decodePacket(p, frame);
  assert.equal(r.messages[0].data.content, "gzip 弹幕");
  assert.equal(r.messages[0].msg_id, "9223372036854775806");
  const ack = p.types.get("webcast.im.PushFrame").original.decode(r.ack());
  assert.equal(ack.payload_type, "ack");
  assert.equal(ack.LogID, "456");
  assert.equal(Buffer.from(ack.payload).toString(), "cursor-context");
  const hb = p.types
    .get("webcast.im.PushFrame")
    .original.encode({ payload_type: "hb" })
    .finish();
  assert.equal(decodePacket(p, hb).kind, "control");
});
test("原始 Response 自动回退，现代 ACK 可使用 response 扩展串", async () => {
  const p = await loadParser(),
    response = p.types
      .get("webcast.im.Response")
      .original.encode({
        cursor: "a",
        messages: [
          {
            method: "WebcastChatMessage",
            payload: p.root
              .lookupType("webcast.im.ChatMessage")
              .encode({ content: "直传 Response" })
              .finish(),
          },
        ],
        need_ack: true,
        internal_ext: "modern-context",
      })
      .finish();
  assert.equal(
    decodePacket(p, response).messages[0].data.content,
    "直传 Response",
  );
  const frame = p.types
    .get("webcast.im.PushFrame")
    .original.encode({
      payload_type: "msg",
      payload_encoding: "pb",
      service: 9999,
      method: 1,
      payload: response,
    })
    .finish();
  const r = decodePacket(p, frame);
  const ack = p.types.get("webcast.im.PushFrame").original.decode(r.ack());
  assert.equal(ack.service, 9999);
  assert.equal(ack.method, 1);
  assert.equal(ack.payload_encoding, "pb");
  assert.equal(
    ack.headers.find((h) => h.key === "X-ByteLink-InternalExt").value,
    "modern-context",
  );
  assert.equal(ack.payload.length, 0);
});
test("超大业务载荷只隔离本消息，其余批次仍解码", async () => {
  const p = await loadParser(),
    valid = p.root
      .lookupType("webcast.im.ChatMessage")
      .encode({ content: "保留同批消息" })
      .finish();
  const response = p.types
    .get("webcast.im.Response")
    .original.encode({
      messages: [
        { method: "WebcastChatMessage", payload: Buffer.alloc(MAX_PACKET + 1) },
        { method: "WebcastChatMessage", payload: valid },
      ],
    })
    .finish();
  const frame = p.types
    .get("webcast.im.PushFrame")
    .original.encode({ payload_type: "msg", payload: zlib.gzipSync(response) })
    .finish();
  const r = decodePacket(p, frame);
  assert.equal(r.messages[0].status, "error");
  assert.ok(r.messages[0].payload_preview_base64.length < 6000);
  assert.equal(r.messages[1].data.content, "保留同批消息");
});
test("HAR 导入按抓包时间选择新版，并清理同族旧文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parser-import-"));
  try {
    const capture = path.join(dir, "capture"),
      vendor = path.join(dir, "vendor");
    await fs.mkdir(capture);
    await fs.mkdir(vendor);
    await fs.writeFile(path.join(vendor, "live-schema-stale.js"), "old");
    await fs.writeFile(
      path.join(capture, "test.har"),
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: "2026-06-28T00:00:00Z",
              request: { url: "https://example.invalid/live-schema.zzz.js" },
              response: { content: { text: "older" } },
            },
            {
              startedDateTime: "2026-10-07T00:00:00Z",
              request: { url: "https://example.invalid/live-schema.aaa.js" },
              response: { content: { text: "newer" } },
            },
          ],
        },
      }),
    );
    await importParsers(capture, vendor);
    assert.equal(
      await fs.readFile(path.join(vendor, "live-schema.aaa.js"), "utf8"),
      "newer",
    );
    assert.deepEqual(
      (await fs.readdir(vendor)).filter((n) => n.endsWith(".js")),
      ["live-schema.aaa.js"],
    );
    await fs.writeFile(
      path.join(vendor, "live-schema.conflict.js"),
      "conflict",
    );
    await assert.rejects(loadParser(vendor), /多个版本/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
