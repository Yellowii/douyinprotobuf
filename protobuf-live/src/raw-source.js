import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { decodeBusiness, decodePacket, MAX_PACKET } from "./decode.js";
import { toBarrage } from "./barrage.js";
import { paths } from "./paths.js";

function inside(parent, child) {
  const r = path.relative(parent, child);
  return (
    !r || (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
  );
}
async function futureRealPath(destination) {
  let parent = path.resolve(destination);
  const missing = [];
  while (true) {
    try {
      await fs.lstat(parent);
      const resolved = await fs.realpath(parent);
      return path.resolve(resolved, ...missing);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      try {
        const s = await fs.lstat(parent);
        if (s.isSymbolicLink())
          throw new Error("无法确认输出链接的实际路径，拒绝写入只读样本");
      } catch (check) {
        if (check.code !== "ENOENT") throw check;
      }
      const next = path.dirname(parent);
      if (next === parent) throw e;
      missing.unshift(path.basename(parent));
      parent = next;
    }
  }
}
export async function readRawPacket(p, file) {
  const handle = await fs.open(file, "r");
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PACKET)
      throw new Error("空包或包大小超过限制");
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error("文件仍在写入，稍后重试");
  } finally {
    await handle.close();
  }
  let meta = {};
  for (const candidate of [
    file + ".meta.json",
    file.replace(/\.bin$/i, ".json"),
  ]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.size > 65536) throw new Error("样本元数据过大");
      const text = (await fs.readFile(candidate, "utf8"))
        .replace(/^\uFEFF/, "")
        .replace(/"(msg_id|offset)"\s*:\s*(-?\d+)(?=\s*[,}])/g, '"$1":"$2"');
      meta = JSON.parse(text);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const match = path.basename(file).match(/(Webcast\w+)_(\d+)\.bin$/i);
  const method = meta.method || match?.[1];
  const result = method
    ? { kind: "business", messages: [decodeBusiness(p, method, bytes)] }
    : decodePacket(p, bytes, { format: meta.format || "auto" });
  for (const m of result.messages || []) {
    if (match?.[2] || meta.msg_id != null)
      m.msg_id = match?.[2] || String(meta.msg_id);
    if (Number.isInteger(meta.msg_type)) m.msg_type = meta.msg_type;
    if (meta.offset != null) m.offset = String(meta.offset);
  }
  return {
    source: path.basename(file),
    received_at: meta.received_at || new Date().toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...result,
  };
}

export async function auditRaw(
  p,
  raw,
  {
    output = paths.output,
    concurrency = 16,
    progress = () => {},
    progressEvery = 10000,
    event = async () => {},
    signal,
    files = null,
    saveEvents = false,
  } = {},
) {
  raw = await fs.realpath(raw);
  // 结果目录必须在输入目录之外；外部源永远只打开 r 模式。
  const destination = path.resolve(output);
  if (inside(raw, destination)) throw new Error("审计输出不能写入只读样本目录");
  if (inside(raw, await futureRealPath(destination)))
    throw new Error("审计输出不能通过链接写入只读样本目录");
  await fs.mkdir(destination, { recursive: true });
  if (inside(raw, await fs.realpath(destination)))
    throw new Error("审计输出不能通过链接写入只读样本目录");
  const failures = await fs.open(
    path.join(destination, "raw-audit.failures.jsonl"),
    "w",
  );
  const unknown = await fs.open(
    path.join(destination, "raw-audit.unknown.jsonl"),
    "w",
  );
  const chats = await fs.open(
    path.join(destination, "raw-audit.barrage.jsonl"),
    "w",
  );
  const report = {
    processed: 0,
    parser_sources: p.sources,
    directory: raw,
    started_at: new Date().toISOString(),
    packets: 0,
    decoded: 0,
    failed: 0,
    unknown: 0,
    methods: Object.create(null),
    observations: Object.create(null),
    source_manifest_sha256: "",
  };
  const events = saveEvents
    ? await fs.open(path.join(destination, "raw-audit.events.jsonl"), "w")
    : null;
  const manifest = createHash("sha256");
  let queue = Promise.resolve();
  const log = (f, v) => {
    queue = queue.then(() => f.write(JSON.stringify(v) + "\n"));
    return queue;
  };
  const pending = new Set();
  let completed = 0;
  const processFile = async (name) => {
    report.packets++;
    let packet;
    try {
      packet = await readRawPacket(p, path.join(raw, name));
      manifest.update(name + "\0" + packet.sha256 + "\n");
      for (const m of packet.messages || []) {
        const stat = (report.methods[m.method] ||= {
          decoded: 0,
          failed: 0,
          unknown: 0,
          type: m.type || null,
        });
        if (m.status === "decoded") {
          report.decoded++;
          stat.decoded++;
        } else if (m.status === "unknown") {
          report.unknown++;
          stat.unknown++;
          await log(unknown, { source: name, ...m });
        } else {
          report.failed++;
          stat.failed++;
          await log(failures, { source: name, ...m });
        }
        if (m.type && Number.isInteger(m.msg_type)) {
          const ids = (report.observations[m.type] ||= []);
          if (!ids.includes(m.msg_type)) ids.push(m.msg_type);
        }
        const barrage = toBarrage(m, packet.received_at);
        if (barrage) await log(chats, barrage);
      }
    } catch (e) {
      report.failed++;
      await log(failures, { source: name, error: e.message });
      packet = {
        source: name,
        received_at: new Date().toISOString(),
        kind: "error",
        messages: [],
        error: e.message,
      };
    }
    if (events) await log(events, packet);
    await event(packet);
    completed++;
    report.processed = completed;
    if (completed % Math.max(1, progressEvery) === 0)
      await progress({
        packets: completed,
        decoded: report.decoded,
        failed: report.failed,
        unknown: report.unknown,
      });
  };
  try {
    const candidates = files
      ? files.map((name) => ({ name, isFile: () => true }))
      : await fs.opendir(raw);
    for await (const e of candidates) {
      if (signal?.aborted) break;
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".bin")) continue;
      if (path.basename(e.name) !== e.name) throw new Error("无效样本文件名");
      const task = processFile(e.name);
      pending.add(task);
      task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      if (pending.size >= Math.max(1, Math.min(32, concurrency)))
        await Promise.race(pending);
    }
    await Promise.all(pending);
    await queue;
  } finally {
    await Promise.allSettled(pending);
    await queue.catch(() => {});
    await Promise.all([
      failures.close(),
      unknown.close(),
      chats.close(),
      events?.close(),
    ]);
  }
  report.finished_at = new Date().toISOString();
  report.cancelled = signal?.aborted === true;
  report.source_manifest_sha256 = manifest.digest("hex");
  await fs.writeFile(
    path.join(destination, "raw-audit.report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}

export class RawSource extends EventEmitter {
  constructor(p, { settleMs = 250, retryMs = 500 } = {}) {
    super();
    this.p = p;
    this.settleMs = settleMs;
    this.retryMs = retryMs;
    this.status = { state: "stopped", mode: "raw", received: 0, errors: 0 };
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.generation = 0;
  }
  async start({ directory }) {
    if (this.status.state !== "stopped")
      throw new Error("请先停止当前样本监听");
    this.directory = await fs.realpath(directory);
    this.baseline = new Set();
    this.processed = new Set();
    const g = ++this.generation;
    // 先安装监听，再建立历史基线，避免扫描期间新文件丢失。
    this.buffered = new Set();
    this.scanning = true;
    this.watcher = watch(this.directory, (_, name) => {
      if (name) this.enqueue(String(name), g);
    });
    this.watcher.on("error", (e) => {
      this.emit("failure", { stage: "raw-watch", error: e.message });
      this.stop();
    });
    try {
      for await (const e of await fs.opendir(this.directory))
        if (e.isFile() && /\.bin$/i.test(e.name)) this.baseline.add(e.name);
      this.scanning = false;
      for (const n of this.buffered) {
        this.baseline.delete(n);
        this.enqueue(n, g);
      }
      this.buffered.clear();
      this.status = {
        state: "connected",
        mode: "raw",
        received: 0,
        errors: 0,
        directory: this.directory,
      };
      this.emit("status", this.status);
      // fs.watch 在部分文件系统可能漏通知；低频扫描补齐，仍只读取新文件。
      this.poll = setInterval(
        () =>
          this.rescan(g).catch((e) =>
            this.emit("failure", { stage: "raw-scan", error: e.message }),
          ),
        60000,
      );
      this.poll.unref();
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async rescan(g) {
    if (this.rescanning) return;
    this.rescanning = true;
    try {
      for await (const e of await fs.opendir(this.directory)) {
        if (g !== this.generation) break;
        if (e.isFile() && /\.bin$/i.test(e.name)) this.enqueue(e.name, g);
      }
    } finally {
      this.rescanning = false;
    }
  }
  enqueue(name, g, attempt = 0) {
    if (
      g !== this.generation ||
      !/\.bin$/i.test(name) ||
      path.basename(name) !== name
    )
      return;
    if (this.scanning) {
      this.buffered.add(name);
      return;
    }
    if (this.baseline.has(name) || this.processed.has(name)) return;
    if (!this.pending.has(name) && this.pending.size >= 1000) {
      this.emit("failure", { stage: "raw-watch", error: "样本监听队列已满" });
      this.stop();
      return;
    }
    clearTimeout(this.pending.get(name));
    const timer = setTimeout(
      () => {
        this.queue = this.queue
          .then(async () => {
            if (g !== this.generation) return;
            if (this.processed.has(name)) {
              this.pending.delete(name);
              return;
            }
            try {
              const file = path.join(this.directory, name);
              const s = await fs.lstat(file);
              if (!s.isFile()) throw new Error("样本必须为普通文件");
              const packet = await readRawPacket(this.p, file);
              const error = packet.messages.find((m) => m.status === "error");
              if (error && attempt < 8) throw new Error(error.error);
              this.processed.add(name);
              this.pending.delete(name);
              this.status.received++;
              if (error)
                this.emit("failure", {
                  source: name,
                  stage: "raw-decode",
                  error: error.error,
                });
              this.emit("packet", packet);
            } catch (e) {
              this.pending.delete(name);
              if (g !== this.generation) return;
              if (attempt < 8) this.enqueue(name, g, attempt + 1);
              else {
                this.processed.add(name);
                this.status.errors++;
                this.emit("failure", {
                  source: name,
                  stage: "raw-read",
                  error: e.message,
                });
              }
            }
          })
          .catch((e) =>
            this.emit("failure", { stage: "raw-watch", error: e.message }),
          );
      },
      attempt ? this.retryMs : this.settleMs,
    );
    this.pending.set(name, timer);
  }
  async stop() {
    this.generation++;
    this.watcher?.close();
    clearInterval(this.poll);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await this.queue;
    this.status = { ...this.status, state: "stopped" };
    this.emit("status", this.status);
  }
}
