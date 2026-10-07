import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadParser } from "../parser.js";
import {
  buildArtifacts,
  validateArtifacts,
  readObservations,
} from "../dictionary.js";
import { createWorkbench } from "../server.js";

test("标准官方反射导出支持多层 message/enum/map/oneof，丢失 descriptor 必须报错", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "descriptor-"));
  try {
    await fs.writeFile(
      path.join(dir, "official-parser.js"),
      `module.exports = require('protobufjs').Root.fromJSON({nested:{demo:{nested:{Sample:{fields:{state:{type:'State',id:1},members:{keyType:'string',type:'Member',id:2},a:{type:'string',id:3},b:{type:'int32',id:4}},oneofs:{selection:{oneof:['a','b']}},nested:{State:{values:{NONE:0,READY:1}},Member:{fields:{id:{type:'uint64',id:1}}}}}}}}});`,
    );
    const p = await loadParser(dir);
    assert.equal(p.types.size, 2);
    assert.equal(p.enums.size, 1);
    assert.equal(p.root.lookupType("demo.Sample").fields.members.map, true);
    assert.deepEqual(p.types.get("demo.Sample").oneofs.selection, ["a", "b"]);
    const a = buildArtifacts(p);
    assert.equal(validateArtifacts(p, a).messages, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("机器字典篡改字段必须被完整产物验证捕获", async () => {
  const p = await loadParser(),
    a = buildArtifacts(p);
  a.dictionary["webcast.im.ChatMessage"].fields.find(
    (f) => f.field_name === "content",
  ).field_number = 99;
  assert.throws(() => validateArtifacts(p, a), /字典/);
});
test("已有样本类型观察在生成字典时可恢复", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observations-"));
  try {
    const file = path.join(dir, "proto.dict");
    await fs.writeFile(
      file,
      JSON.stringify({
        "webcast.im.ChatMessage": { observed_msg_type_ids: [2] },
      }),
    );
    assert.deepEqual(await readObservations(file), {
      "webcast.im.ChatMessage": [2],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("工作台跨源、无令牌写请求被拒绝，字典查询正常", async () => {
  const app = await createWorkbench(await loadParser(), { port: 0 });
  try {
    assert.equal(
      (
        await fetch(app.url + "/api/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.url + "/api/session", {
          headers: { Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(app.url + "/api/schema?name=__proto__")).status,
      404,
    );
    const r = await fetch(
      app.url + "/api/schema?name=webcast.im.ChatMessage",
    ).then((r) => r.json());
    assert.equal(
      r.fields.find((f) => f.field_name === "content").field_number,
      3,
    );
  } finally {
    await app.close();
  }
});
