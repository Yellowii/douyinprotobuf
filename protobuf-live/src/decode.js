import zlib from "node:zlib";
import protobuf from "protobufjs";
export const MAX_PACKET = 8 * 1024 * 1024,
  MAX_DECOMPRESSED = 32 * 1024 * 1024;
function plain(p, t, obj, depth = 0) {
  if (depth > 80) throw new Error("消息嵌套深度超过限制");
  if (obj == null) return obj;
  const out = {};
  for (const f of t.fields) {
    const value = obj[f.name];
    if (value == null) continue;
    const one = (v) =>
      p.types.has(f.type)
        ? plain(p, p.types.get(f.type), v, depth + 1)
        : f.type === "bytes"
          ? Buffer.from(v).toString("base64")
          : /64$/.test(f.type)
            ? v.toString()
            : v;
    if (f.keyType) {
      const map = Object.create(null);
      for (const [k, v] of Object.entries(value)) {
        const key =
          /64$/.test(f.keyType) && k.length === 8
            ? protobuf.util
                .longFromHash(
                  k,
                  f.keyType.startsWith("u") || f.keyType === "fixed64",
                )
                .toString()
            : k;
        map[key] = one(v);
      }
      out[f.name] = map;
    } else out[f.name] = f.repeated ? value.map(one) : one(value);
  }
  return out;
}
export function resolveBusiness(p, method) {
  const short = method.replace(/^Webcast/, "");
  if (p.types.has(method)) return p.types.get(method);
  if (p.types.has(`webcast.im.${short}`))
    return p.types.get(`webcast.im.${short}`);
  const candidates = [...p.types.values()].filter(
    (t) => t.fullName.split(".").at(-1) === short,
  );
  return candidates.length === 1 ? candidates[0] : null;
}
export function decodeBusiness(p, method, bytes) {
  const t = resolveBusiness(p, method);
  if (bytes.length > MAX_PACKET)
    return {
      method,
      type: t?.fullName,
      status: "error",
      error: "业务消息大小超过限制",
      payload_length: bytes.length,
      payload_preview_base64: Buffer.from(bytes.subarray(0, 4096)).toString(
        "base64",
      ),
    };
  if (!t)
    return {
      method,
      status: "unknown",
      payload_base64: Buffer.from(bytes).toString("base64"),
    };
  try {
    return {
      method,
      type: t.fullName,
      status: "decoded",
      data: plain(p, t, t.original.decode(bytes)),
    };
  } catch (e) {
    return {
      method,
      type: t.fullName,
      status: "error",
      error: e.message,
      payload_base64: Buffer.from(bytes).toString("base64"),
    };
  }
}
function decompress(bytes, encoding) {
  const opts = { maxOutputLength: MAX_DECOMPRESSED };
  if ((bytes[0] === 31 && bytes[1] === 139) || encoding === "gzip")
    return zlib.gunzipSync(bytes, opts);
  if (encoding === "zlib" || encoding === "deflate")
    return zlib.inflateSync(bytes, opts);
  if (encoding === "zstd") return zlib.zstdDecompressSync(bytes, opts);
  if (
    encoding &&
    !["pb", "protobuf", "none", "identity", ""].includes(encoding)
  )
    throw new Error(`未知压缩方式：${encoding}`);
  return bytes;
}
export function decodePacket(
  p,
  bytes,
  { format = "auto", modernAck = false } = {},
) {
  if (!bytes.length || bytes.length > MAX_PACKET)
    throw new Error("空包或包大小超过限制");
  const frameType = p.types.get("webcast.im.PushFrame"),
    respType = p.types.get("webcast.im.Response");
  if (!frameType || !respType)
    throw new Error("官方 Parser 缺少 PushFrame 或 Response");
  let frame, rawResponse, response;
  let frameError;
  if (format !== "response") {
    try {
      const f = frameType.original.decode(bytes);
      if (f.payload?.length || f.payload_type) {
        frame = f;
        const headers = Object.fromEntries(
          (f.headers || []).map((h) => [h.key, h.value]),
        );
        const kind = (f.payload_type || "").toLowerCase();
        if (["hb", "ack", "heartbeat", "pong", "ping", "close"].includes(kind))
          return {
            kind: "control",
            frame: plain(p, frameType, f),
            messages: [],
          };
        let encoding =
          headers.compress_type ||
          headers["compress-type"] ||
          f.payload_encoding;
        rawResponse = decompress(Buffer.from(f.payload || []), encoding);
      } else if (format === "frame") throw new Error("未识别 PushFrame 载荷");
    } catch (e) {
      if (format === "frame") throw e;
      frameError = e;
      frame = null;
      rawResponse = null;
    }
  }
  try {
    response = respType.original.decode(rawResponse || bytes);
  } catch (e) {
    throw frameError || e;
  }
  if (
    !(response.messages || response.messages_list)?.length &&
    !frame &&
    !response.cursor &&
    !response.internal_ext
  )
    throw new Error("未识别有效 Response 或 PushFrame");
  const envelopes = response.messages || response.messages_list || [];
  const messages = envelopes.map((m) => ({
    ...decodeBusiness(p, m.method, Buffer.from(m.payload || [])),
    msg_id: String(m.msg_id || 0),
    msg_type: Number(m.msg_type || 0),
    offset: String(m.offset || 0),
  }));
  const result = {
    kind: "messages",
    frame: frame ? plain(p, frameType, frame) : null,
    response: plain(p, respType, response),
    messages,
  };
  // 回执编码使用官方传输模块，结构由运行时确定。
  Object.defineProperty(result, "ack", {
    enumerable: false,
    value:
      response.need_ack && frame
        ? () => {
            const headers = Object.fromEntries(
              (frame.headers || []).map((h) => [h.key, h.value]),
            );
            const ext =
              headers["X-ByteLink-InternalExt"] || response.internal_ext || "";
            const modern =
              modernAck ||
              Number(frame.service) === 9999 ||
              !!headers["X-ByteLink-InternalExt"];
            return frameType.original
              .encode({
                SeqID: frame.SeqID,
                LogID: frame.LogID,
                service: modern ? 9999 : frame.service,
                method: modern ? 1 : frame.method,
                payload_type: "ack",
                payload_encoding: modern ? "pb" : "",
                headers: modern
                  ? [
                      { key: "X-ByteLink-InternalExt", value: ext },
                      {
                        key: "client_recv_times_ms",
                        value: String(Date.now()),
                      },
                      { key: "client_ack_time_ms", value: String(Date.now()) },
                    ]
                  : [],
                payload: modern ? Buffer.alloc(0) : Buffer.from(ext),
              })
              .finish();
          }
        : null,
  });
  return result;
}
export function heartbeat(p, seq = "0", { modern = false } = {}) {
  return p.types
    .get("webcast.im.PushFrame")
    .original.encode({
      SeqID: seq,
      LogID: seq,
      service: modern ? 9999 : 0,
      method: modern ? 1 : 0,
      payload_type: "hb",
      payload_encoding: modern ? "pb" : "",
    })
    .finish();
}
