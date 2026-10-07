import test from "node:test";
import assert from "node:assert/strict";
import protobuf from "protobufjs";
import { loadParser } from "../parser.js";
import { buildArtifacts, validateArtifacts } from "../dictionary.js";
import { decodePacket, decodeBusiness } from "../decode.js";

test("官方运行时所有字段可导出，包含传输层和业务层", async () => {
  const p = await loadParser();
  assert.ok(p.types.size > 1000);
  assert.equal(
    p.root.lookupType("webcast.im.ChatMessage").fields.content.id,
    3,
  );
  assert.equal(
    p.root.lookupType("webcast.im.ChatMessage").fields.model_info.map,
    true,
  );
  assert.equal(
    p.root.lookupType("webcast.im.PushFrame").fields.SeqID.type,
    "uint64",
  );
  assert.ok(p.enums.size > 0);
  assert.equal(p.missingFields.length, 0);
});

test("双产物标准 proto3 可重新加载且所有声明有中文注释", async () => {
  const p = await loadParser();
  const a = buildArtifacts(p);
  const r = protobuf.parse(a.proto, { keepCase: true }).root;
  r.resolveAll();
  assert.equal(
    r.lookupType("webcast.im.ChatMessage").fields.model_info.keyType,
    "string",
  );
  assert.equal(validateArtifacts(p, a).messages, p.types.size);
  for (const line of a.proto
    .split("\n")
    .filter((x) => /\b(message|enum)\s|=\s*-?\d+/.test(x)))
    assert.match(line, /\/\/.*[\u4e00-\u9fff]/);
  assert.deepEqual(buildArtifacts(p), a);
});

test("官方 parser 解码业务消息且保留精确 64 位整数，未知方法保留 bytes", async () => {
  const p = await loadParser();
  const t = p.root.lookupType("webcast.im.ChatMessage");
  const bytes = t
    .encode(
      t.fromObject({
        content: "测试弹幕",
        common: { msg_id: "9223372036854775806" },
      }),
    )
    .finish();
  const r = decodeBusiness(p, "WebcastChatMessage", bytes);
  assert.equal(r.data.content, "测试弹幕");
  assert.equal(r.data.common.msg_id, "9223372036854775806");
  assert.equal(
    decodeBusiness(p, "WebcastNotYetKnownMessage", bytes).status,
    "unknown",
  );
  assert.throws(() => decodePacket(p, Buffer.from([255])), /./);
});
