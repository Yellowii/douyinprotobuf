import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { loadParser, forgetParser } from "./parser.js";
import {
  buildArtifacts,
  validateArtifacts,
  readObservations,
} from "./dictionary.js";
import { discoverOfficial } from "./parser-discovery.js";
import { paths } from "./paths.js";

const fingerprint = (p) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        p.sources
          .map((s) => ({ file: s.file, sha256: s.sha256 }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      ),
    )
    .digest("hex");
const fieldShape = (f) => ({
  name: f.name,
  id: f.id,
  type: f.type,
  repeated: !!f.repeated,
  packed: !!f.packed,
  keyType: f.keyType || null,
  optional: !!f.optional,
});
export function diffParsers(before, after) {
  const d = {
    messages: { added: [], removed: [] },
    fields: { added: [], removed: [], changed: [] },
    oneofs: [],
    enums: { added: [], removed: [], changed: [] },
  };
  for (const [name, t] of before.types) {
    const newer = after.types.get(name);
    if (!newer) {
      d.messages.removed.push(name);
      continue;
    }
    const oldFields = new Map(t.fields.map((f) => [f.name, fieldShape(f)]));
    const newFields = new Map(newer.fields.map((f) => [f.name, fieldShape(f)]));
    for (const [n, f] of oldFields) {
      const next = newFields.get(n);
      if (!next) d.fields.removed.push({ message: name, ...f });
      else if (JSON.stringify(f) !== JSON.stringify(next))
        d.fields.changed.push({
          message: name,
          field: n,
          before: f,
          after: next,
        });
    }
    for (const [n, f] of newFields)
      if (!oldFields.has(n)) d.fields.added.push({ message: name, ...f });
    if (JSON.stringify(t.oneofs) !== JSON.stringify(newer.oneofs))
      d.oneofs.push({ message: name, before: t.oneofs, after: newer.oneofs });
  }
  for (const name of after.types.keys())
    if (!before.types.has(name)) d.messages.added.push(name);
  for (const [name, e] of before.enums) {
    const next = after.enums.get(name);
    if (!next) d.enums.removed.push(name);
    else if (JSON.stringify(e.values) !== JSON.stringify(next.values))
      d.enums.changed.push({ name, before: e.values, after: next.values });
  }
  for (const name of after.enums.keys())
    if (!before.enums.has(name)) d.enums.added.push(name);
  return d;
}
function summary(d) {
  return `消息新增 ${d.messages.added.length}、删除 ${d.messages.removed.length}；字段新增 ${d.fields.added.length}、删除 ${d.fields.removed.length}、修改 ${d.fields.changed.length}；枚举新增 ${d.enums.added.length}、删除 ${d.enums.removed.length}、修改 ${d.enums.changed.length}；互斥组修改 ${d.oneofs.length}`;
}

export class ParserUpdater extends EventEmitter {
  constructor(
    p,
    {
      vendor = process.env.PARSER_DIR || paths.vendor,
      output = paths.output,
      dist = paths.dist,
      protoDump = paths.proto_dump,
      intervalMs = Number(process.env.PARSER_UPDATE_INTERVAL_HOURS || 24) *
        3600000,
      minCheckMs = 300000,
      discover = discoverOfficial,
      validateCandidate = async () => {},
      activate = async () => {},
      observations = null,
      withCommit = async (job) => job(),
    } = {},
  ) {
    super();
    if (!Number.isFinite(intervalMs) || intervalMs < 3600000)
      throw new Error("Parser 自动检查间隔至少 1 小时");
    this.p = p;
    this.vendor = path.resolve(vendor);
    this.output = path.resolve(output);
    this.dist = path.resolve(dist);
    this.protoDump = path.resolve(protoDump);
    this.intervalMs = intervalMs;
    this.minCheckMs = minCheckMs;
    this.discover = discover;
    this.validateCandidate = validateCandidate;
    this.activate = activate;
    this.observations = observations;
    this.withCommit = withCommit;
    this.status = {
      status: "idle",
      message: "等待检查",
      interval_hours: intervalMs / 3600000,
    };
  }
  async restore() {
    if (this.restored) return;
    await fs.mkdir(this.output, { recursive: true });
    try {
      const state = JSON.parse(
        await fs.readFile(
          path.join(this.output, "parser-update-state.json"),
          "utf8",
        ),
      );
      this.lastCheck = Number(state.last_check) || 0;
      this.status = { ...this.status, ...state.status };
    } catch {}
    this.restored = true;
  }
  start() {
    this.timer = setTimeout(
      () => {
        this.check()
          .catch((e) => this.emit("failure", { error: e.message }))
          .finally(() => {
            if (!this.closed) this.start();
          });
      },
      Math.max(
        1000,
        (this.lastCheck || Date.now()) + this.intervalMs - Date.now(),
      ),
    );
    this.timer.unref();
  }
  async schedule() {
    await this.restore();
    this.start();
  }
  async check(options = {}) {
    if (this.closed) throw new Error("Parser 更新器已关闭");
    if (this.running) return this.running;
    this.running = this.perform(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async record(result) {
    this.status = result;
    await fs.appendFile(
      path.join(this.output, "parser-updates.jsonl"),
      JSON.stringify(result) + "\n",
    );
    const temp = path.join(this.output, "parser-update-state.json.tmp");
    await fs.writeFile(
      temp,
      JSON.stringify({ last_check: this.lastCheck, status: result }, null, 2),
    );
    await fs.rename(temp, path.join(this.output, "parser-update-state.json"));
    this.emit("status", result);
    return result;
  }
  async perform(options) {
    await this.restore();
    if (Date.now() - (this.lastCheck || 0) < this.minCheckMs)
      return {
        status: "throttled",
        message: "Parser 检查冷却中，至少间隔 5 分钟",
        last_check: this.lastCheck,
      };
    this.lastCheck = Date.now();
    const stamp = new Date(this.lastCheck).toISOString(),
      id = randomUUID(),
      stage = path.join(this.output, "parser-versions", id);
    this.status = {
      status: "checking",
      message: "正在检查官方 Parser",
      checked_at: stamp,
    };
    await this.record(this.status);
    await fs.mkdir(stage, { recursive: true });
    const old = this.p;
    try {
      const candidateSources = await this.discover(options);
      if (!candidateSources.length || candidateSources.length > 3)
        throw new Error("官方 Parser 候选数量无效");
      for (const item of candidateSources) {
        if (
          !/^(?:(?:live-schema|transport-schema)[\w.-]*|official-parser)\.js$/.test(
            item.file,
          ) ||
          typeof item.source !== "string" ||
          Buffer.byteLength(item.source) > 8 * 1024 * 1024
        )
          throw new Error("官方 Parser 候选文件无效");
        await fs.writeFile(path.join(stage, item.file), item.source);
      }
      await fs.writeFile(
        path.join(stage, "provenance.json"),
        JSON.stringify(
          candidateSources.map((s) => ({
            file: s.file,
            url: s.url,
            captured_at: stamp,
            sha256: createHash("sha256").update(s.source).digest("hex"),
          })),
          null,
          2,
        ) + "\n",
      );
      const next = await loadParser(stage, { fresh: true });
      if (
        !next.types.has("webcast.im.PushFrame") ||
        !next.types.has("webcast.im.Response")
      )
        throw new Error("候选缺少 WebCast 外层协议");
      const diff = diffParsers(old, next);
      const changed = fingerprint(old) !== fingerprint(next);
      const result = {
        status: changed ? "updated" : "unchanged",
        checked_at: stamp,
        version: id,
        before: old.sources,
        after: next.sources,
        diff,
        message: changed ? summary(diff) : "官方 Parser 与当前版本相同",
      };
      await fs.writeFile(
        path.join(stage, "diff.json"),
        JSON.stringify(result, null, 2),
      );
      await fs.writeFile(
        path.join(stage, "diff.md"),
        `# 官方 Parser 新旧差异\n\n检查时间：${stamp}\n\n${result.message}\n\n旧版：${old.sources.map((s) => s.file).join("、")}\n\n新版：${next.sources.map((s) => s.file).join("、")}\n\n\`\`\`json\n${JSON.stringify(diff, null, 2)}\n\`\`\`\n`,
      );
      const observations =
        this.observations ||
        (await readObservations(path.join(this.dist, "proto.dict")));
      const artifacts = buildArtifacts(next, observations);
      validateArtifacts(next, artifacts);
      await this.validateCandidate(next, old);
      return await this.withCommit(async () => {
        // 存档旧版与成品，全部候选校验成功后才触碰正式文件；失败逐项恢复。
        const targets = [];
        const backup = path.join(stage, "previous");
        await fs.mkdir(backup);
        for (const name of await fs.readdir(this.vendor))
          if (
            /^(?:live-schema|transport-schema).*\.js$|^official-parser\.js$|^provenance\.json$/.test(
              name,
            )
          )
            targets.push({
              file: path.join(this.vendor, name),
              next:
                candidateSources.find((s) => s.file === name)?.source ?? null,
            });
        for (const s of candidateSources)
          if (!targets.some((t) => t.file === path.join(this.vendor, s.file)))
            targets.push({
              file: path.join(this.vendor, s.file),
              next: s.source,
            });
        const provenance = await fs.readFile(
          path.join(stage, "provenance.json"),
        );
        const provenancePath = path.join(this.vendor, "provenance.json");
        const prov = targets.find((t) => t.file === provenancePath);
        if (prov) prov.next = provenance;
        else targets.push({ file: provenancePath, next: provenance });
        targets.push(
          {
            file: path.join(this.dist, "proto.dict"),
            next: JSON.stringify(artifacts.dictionary, null, 2) + "\n",
          },
          {
            file: path.join(this.protoDump, "live_debug_snapshot.proto"),
            next: artifacts.proto,
          },
        );
        for (const [i, t] of targets.entries()) {
          try {
            t.before = await fs.readFile(t.file);
            await fs.writeFile(path.join(backup, String(i)), t.before);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        await fs.writeFile(
          path.join(backup, "manifest.json"),
          JSON.stringify(
            targets.map((t, i) => ({
              file: t.file,
              backup: String(i),
              existed: t.before !== undefined,
            })),
            null,
            2,
          ),
        );
        try {
          for (const t of targets) {
            await fs.mkdir(path.dirname(t.file), { recursive: true });
            if (t.next === null) await fs.rm(t.file, { force: true });
            else {
              await fs.writeFile(t.file + ".update-tmp", t.next);
              await fs.rename(t.file + ".update-tmp", t.file);
            }
          }
          await this.activate(next, artifacts);
          this.p = next;
          forgetParser(this.vendor);
          return await this.record(result);
        } catch (e) {
          for (const t of targets) {
            if (t.before === undefined) await fs.rm(t.file, { force: true });
            else await fs.writeFile(t.file, t.before);
            await fs.rm(t.file + ".update-tmp", { force: true });
          }
          this.p = old;
          await this.activate(old, buildArtifacts(old, observations));
          forgetParser(this.vendor);
          throw e;
        }
      });
    } catch (e) {
      return await this.record({
        status: "failed",
        checked_at: stamp,
        version: id,
        before: old.sources,
        message: "官方 Parser 更新失败，保留旧版",
        error: e.message,
      });
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
