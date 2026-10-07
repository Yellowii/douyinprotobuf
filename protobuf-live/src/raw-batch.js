import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { auditRaw } from "./raw-source.js";
import { paths } from "./paths.js";

// 已有文件批量解析与实时目录监听分开：单次任务固定文件列表，所有源文件只读。
export class RawBatch extends EventEmitter {
  constructor(
    p,
    {
      output = path.join(paths.output, "raw-batches"),
      previewMs = 150,
      finish = async () => {},
    } = {},
  ) {
    super();
    this.p = p;
    this.output = path.resolve(output);
    this.previewMs = previewMs;
    this.finish = finish;
    this.status = { state: "stopped", mode: "raw-batch" };
  }
  update(values) {
    this.status = { ...this.status, ...values };
    this.emit("status", this.status);
  }
  async start({ directory }) {
    if (
      this.task &&
      !["completed", "cancelled", "failed", "stopped"].includes(
        this.status.state,
      )
    )
      throw new Error("已有批量任务正在运行");
    const resolved = await fs.realpath(directory);
    if (!(await fs.stat(resolved)).isDirectory())
      throw new Error("请选择原始包文件夹");
    this.controller = new AbortController();
    this.report = null;
    this.preview = [];
    this.lastPreview = 0;
    this.lastProgress = 0;
    const job_id = randomUUID();
    this.status = {
      state: "scanning",
      mode: "raw-batch",
      job_id,
      directory: resolved,
      total: null,
      scanned: 0,
      processed: 0,
      decoded: 0,
      failed: 0,
      unknown: 0,
      output: path.join(this.output, job_id),
    };
    this.update({});
    this.task = this.run();
    return this.status;
  }
  flush() {
    if (!this.preview.length) return;
    this.emit("packet", {
      kind: "batch-preview",
      source: "raw-batch",
      messages: this.preview.splice(0),
      received_at: new Date().toISOString(),
    });
    this.lastPreview = Date.now();
  }
  async run() {
    try {
      const files = [];
      for await (const e of await fs.opendir(this.status.directory)) {
        if (this.controller.signal.aborted) break;
        if (e.isFile() && /\.bin$/i.test(e.name)) files.push(e.name);
        if (files.length && Date.now() - this.lastProgress >= 250) {
          this.lastProgress = Date.now();
          this.update({ scanned: files.length });
        }
      }
      this.update({
        state: "running",
        total: files.length,
        scanned: files.length,
      });
      this.report = await auditRaw(this.p, this.status.directory, {
        output: this.status.output,
        files,
        signal: this.controller.signal,
        saveEvents: true,
        progressEvery: 1,
        event: async (packet) => {
          this.preview.push(...packet.messages);
          this.preview = this.preview.slice(-50);
          if (Date.now() - this.lastPreview >= this.previewMs) this.flush();
        },
        progress: (s) => {
          if (!this.status.processed || Date.now() - this.lastProgress >= 150) {
            this.lastProgress = Date.now();
            this.update({
              processed: s.packets,
              decoded: s.decoded,
              failed: s.failed,
              unknown: s.unknown,
            });
          }
        },
      });
      this.flush();
      this.update({
        state: "saving",
        processed: this.report.processed,
        decoded: this.report.decoded,
        failed: this.report.failed,
        unknown: this.report.unknown,
      });
      await this.finish(this.report);
      this.update({
        state: this.report.cancelled ? "cancelled" : "completed",
        finished_at: this.report.finished_at,
      });
    } catch (e) {
      this.flush();
      this.update({ state: "failed", reason: e.message });
      this.emit("failure", { stage: "raw-batch", error: e.message });
    }
  }
  async stop() {
    this.controller?.abort();
    await this.task;
  }
}
