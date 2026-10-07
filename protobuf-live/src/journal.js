import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.js";
import { createHash } from "node:crypto";
export class Journal {
  constructor() {
    this.pending = 0;
    this.rawBytes = 0;
    this.sequence = 0;
    this.session = `${Date.now()}-${process.pid}`;
    this.queue = Promise.resolve();
    this.failure = null;
  }
  async open() {
    await fs.mkdir(paths.output, { recursive: true });
    await fs.mkdir(paths.raw_packets, { recursive: true });
    this.events = await fs.open(
      path.join(paths.output, "live.events.jsonl"),
      "a",
    );
    this.errors = await fs.open(
      path.join(paths.output, "live.failures.jsonl"),
      "a",
    );
  }
  append(event, error = false) {
    if (this.pending >= 100) throw new Error("日志队列超过上限");
    this.pending++;
    const line =
      JSON.stringify({ received_at: new Date().toISOString(), ...event }) +
      "\n";
    this.queue = this.queue
      .then(() => {
        if (this.failure) return;
        return (error ? this.errors : this.events).write(line);
      })
      .catch((e) => {
        this.failure = e;
      })
      .finally(() => this.pending--);
    return this.queue;
  }
  appendRaw(bytes, source) {
    if (this.pending >= 100 || this.rawBytes + bytes.length > 32 * 1024 * 1024)
      throw new Error("原包存档队列超过上限");
    this.pending++;
    this.rawBytes += bytes.length;
    const name = `live-${this.session}-${++this.sequence}.bin`;
    const metadata = {
      source,
      format: "frame",
      received_at: new Date().toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    this.queue = this.queue
      .then(async () => {
        if (this.failure) return;
        await fs.writeFile(path.join(paths.raw_packets, name), bytes);
        await fs.writeFile(
          path.join(paths.raw_packets, name + ".meta.json"),
          JSON.stringify(metadata),
        );
      })
      .catch((e) => {
        this.failure = e;
      })
      .finally(() => {
        this.pending--;
        this.rawBytes -= bytes.length;
      });
    return this.queue;
  }
  async close() {
    await this.queue;
    await this.events?.close();
    await this.errors?.close();
  }
}
