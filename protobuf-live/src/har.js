import fs from "node:fs";
import fsp from "node:fs/promises";
import { compose } from "node:stream";
import path from "node:path";
import { createHash } from "node:crypto";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
export async function* entries(file) {
  if ((await fsp.stat(file)).size > 1024 * 1024 * 1024)
    throw new Error("HAR 超过单文件 1GB 限制");
  const input = fs.createReadStream(file);
  const stream = compose(
    input,
    parser.asStream(),
    pick.asStream({ filter: "log.entries", maxDepth: 128 }),
    streamArray.asStream(),
  );
  try {
    for await (const item of stream) yield item;
  } finally {
    stream.destroy();
    input.destroy();
  }
}
export function strictBase64(data) {
  if (
    typeof data !== "string" ||
    !data.length ||
    data.length > 12 * 1024 * 1024 ||
    data.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error("无效 base64 或内容超过上限");
  const b = Buffer.from(data, "base64");
  if (b.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, ""))
    throw new Error("非规范 base64");
  return b;
}
export async function importParsers(capture, vendor) {
  await fsp.mkdir(vendor, { recursive: true });
  const selected = new Map();
  for (const name of (await fsp.readdir(capture))
    .filter((n) => n.toLowerCase().endsWith(".har"))
    .sort()) {
    for await (const { key, value: e } of entries(path.join(capture, name))) {
      const url = e.request?.url || "",
        c = e.response?.content || {};
      if (
        !/(?:live-schema|transport-schema).*\.js(?:\?|$)/.test(url) ||
        !c.text
      )
        continue;
      const source =
        c.encoding === "base64"
          ? strictBase64(c.text).toString("utf8")
          : c.text;
      const filename = path.basename(new URL(url).pathname);
      if (!/^[\w.-]+\.js$/.test(filename)) continue;
      const role = filename.startsWith("transport-schema")
        ? "transport"
        : "live";
      const stamp = Date.parse(e.startedDateTime) || 0;
      const previous = selected.get(role);
      if (!previous || stamp >= previous.stamp)
        selected.set(role, {
          stamp,
          source,
          meta: {
            file: filename,
            url: new URL(url).origin + new URL(url).pathname,
            har: name,
            entry: key,
            sha256: createHash("sha256").update(source).digest("hex"),
            captured_at: e.startedDateTime,
          },
        });
    }
  }
  if (!selected.size)
    throw new Error(
      "HAR 内未发现完整 live-schema/transport-schema JS；请在浏览器刷新并保留响应内容后重新导出",
    );
  for (const [role, item] of selected) {
    await fsp.writeFile(path.join(vendor, item.meta.file), item.source);
    for (const name of await fsp.readdir(vendor)) {
      if (name === item.meta.file) continue;
      if (
        (role === "transport"
          ? /^transport-schema.*\.js$/
          : /^live-schema.*\.js$/
        ).test(name)
      )
        await fsp.unlink(path.join(vendor, name));
    }
  }
  const sources = [...selected.values()].map((x) => x.meta);
  await fsp.writeFile(
    path.join(vendor, "provenance.json"),
    JSON.stringify(sources, null, 2) + "\n",
  );
  return sources;
}
