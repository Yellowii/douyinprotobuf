import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { entries, strictBase64 } from "./har.js";
import { decodePacket, decodeBusiness } from "./decode.js";
import { paths } from "./paths.js";
import { writeArtifacts } from "./dictionary.js";

export async function extractHar(file, raw, failure = () => {}) {
  await fs.mkdir(raw, { recursive: true });
  const stats = { entries: 0, extracted: 0, failed: 0 };
  const prefix = path.basename(file).replace(/[^\w.-]/g, "_");
  for await (const { key, value: e } of entries(file)) {
    stats.entries++;
    if (!/^wss?:\/\//i.test(e.request?.url || "") && !e._webSocketMessages)
      continue;
    for (const [index, m] of (e._webSocketMessages || []).entries()) {
      if (m.type !== "receive" || Number(m.opcode) !== 2) continue;
      const name = `${prefix}.e${key}.f${index}.bin`;
      try {
        const bytes = strictBase64(m.data);
        await fs.writeFile(path.join(raw, name), bytes);
        await fs.writeFile(
          path.join(raw, name + ".meta.json"),
          JSON.stringify({
            source: prefix,
            entry: key,
            frame: index,
            time: m.time,
            format: "frame",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }),
        );
        stats.extracted++;
      } catch (e) {
        stats.failed++;
        await failure({
          source: prefix,
          entry: key,
          frame: index,
          stage: "base64",
          error: e.message,
        });
      }
    }
  }
  return stats;
}
export async function parseRawDirectory(
  p,
  raw,
  { event = () => {}, failure = () => {}, unknown = () => {} } = {},
) {
  const report = {
    packets: 0,
    decoded: 0,
    failed: 0,
    messages: 0,
    unknown: 0,
    methods: {},
    observations: {},
  };
  for (const name of (await fs.readdir(raw))
    .filter((n) => n.endsWith(".bin"))
    .sort()) {
    report.packets++;
    try {
      let meta = {};
      try {
        meta = JSON.parse(
          await fs.readFile(path.join(raw, name + ".meta.json"), "utf8"),
        );
      } catch {}
      const method = meta.method || name.match(/(Webcast\w+)_(\d+)\.bin$/)?.[1];
      const bytes = await fs.readFile(path.join(raw, name));
      const decoded = method
        ? { kind: "business", messages: [decodeBusiness(p, method, bytes)] }
        : decodePacket(p, bytes, { format: meta.format || "auto" });
      for (const m of decoded.messages) {
        report.messages++;
        report.methods[m.method] = (report.methods[m.method] || 0) + 1;
        if (m.status === "error") {
          report.failed++;
          await failure({ source: name, stage: "business", ...m });
        }
        if (m.status === "unknown") {
          report.unknown++;
          await unknown({ source: name, ...m });
        }
        if (m.type && Number.isInteger(m.msg_type ?? meta.msg_type)) {
          const ids = (report.observations[m.type] ||= []);
          const n = m.msg_type ?? meta.msg_type;
          if (!ids.includes(n)) ids.push(n);
        }
      }
      report.decoded++;
      await event({
        source: name,
        received_at: new Date().toISOString(),
        ...decoded,
      });
    } catch (e) {
      report.failed++;
      await failure({ source: name, stage: "packet", error: e.message });
    }
  }
  return report;
}
export async function runOffline(
  p,
  {
    capture = paths.capture,
    raw = paths.raw_packets,
    output = paths.output,
  } = {},
) {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(raw, { recursive: true });
  await fs.mkdir(capture, { recursive: true });
  const files = {};
  for (const n of ["events", "failures", "unknown"]) {
    files[n] = await fs.open(path.join(output, `${n}.jsonl`), "w");
  }
  const log = (n) => async (e) => {
    await files[n].write(JSON.stringify(e) + "\n");
  };
  const extraction = {};
  let report;
  try {
    for (const name of (await fs.readdir(capture))
      .filter((n) => n.toLowerCase().endsWith(".har"))
      .sort()) {
      try {
        extraction[name] = await extractHar(
          path.join(capture, name),
          raw,
          log("failures"),
        );
      } catch (e) {
        await log("failures")({ source: name, stage: "har", error: e.message });
        extraction[name] = { error: e.message };
      }
    }
    report = await parseRawDirectory(p, raw, {
      event: log("events"),
      failure: log("failures"),
      unknown: log("unknown"),
    });
  } finally {
    for (const f of Object.values(files)) await f.close();
  }
  const dictionary = await writeArtifacts(p, report.observations);
  const summary = { extraction, ...report, dictionary };
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  return summary;
}
