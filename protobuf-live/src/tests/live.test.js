import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { LiveClient, validateTarget } from "../live.js";
import { loadParser } from "../parser.js";
test("公网连接只接受抖音安全 WSS，禁止凭据 URL 和伪造域名", () => {
  assert.throws(() => validateTarget("ws://webcast.douyin.com/"), /WSS/);
  assert.throws(() => validateTarget("wss://douyin.com.evil.test/"), /域名/);
  assert.throws(
    () => validateTarget("wss://user:password@webcast.douyin.com/"),
    /凭据/,
  );
  assert.ok(
    validateTarget("wss://webcast3-ws-web-hl.douyin.com/webcast/im/push/v2/"),
  );
});
test("本地长连接接收下行、回 ACK、停止后无重连", async () => {
  const p = await loadParser(),
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let connections = 0;
  const ack = new Promise((resolve) =>
    server.on("connection", (ws) => {
      connections++;
      ws.on("message", (bytes) =>
        resolve(p.types.get("webcast.im.PushFrame").original.decode(bytes)),
      );
      const response = p.types
        .get("webcast.im.Response")
        .original.encode({ messages: [], need_ack: true, internal_ext: "test" })
        .finish();
      ws.send(
        p.types
          .get("webcast.im.PushFrame")
          .original.encode({
            payload_type: "msg",
            payload: response,
            LogID: "8",
          })
          .finish(),
      );
    }),
  );
  const client = new LiveClient(p, {
    allowLocalTest: true,
    minConnectMs: 10,
    heartbeatMs: 30000,
  });
  let received = 0;
  client.on("packet", () => received++);
  try {
    await client.start({
      url: `ws://127.0.0.1:${server.address().port}`,
      cookie: "",
    });
    const r = await Promise.race([
      ack,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ACK timeout")), 3000).unref(),
      ),
    ]);
    assert.equal(r.payload_type, "ack");
    await client.stop();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(received, 1);
    assert.equal(connections, 1);
    assert.equal(client.status.state, "stopped");
  } finally {
    await client.stop();
    for (const c of server.clients) c.terminate();
    await new Promise((r) => server.close(r));
  }
});
