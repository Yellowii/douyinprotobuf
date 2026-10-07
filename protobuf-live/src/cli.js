import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.js";
import { loadParser } from "./parser.js";
import { writeArtifacts, validateArtifacts } from "./dictionary.js";
import { runOffline } from "./offline.js";
import { importParsers } from "./har.js";
import { createWorkbench } from "./server.js";
import { ParserUpdater } from "./parser-update.js";
import { auditRaw, RawSource } from "./raw-source.js";
const [command = "serve", ...args] = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
try {
  for (const dir of Object.values(paths))
    await fs.mkdir(dir, { recursive: true });
  if (command === "import") {
    console.log("正在从 HAR 提取官方协议模块…");
    const sources = await importParsers(
      option("--capture", paths.capture),
      paths.vendor,
    );
    console.log(`导入 ${sources.length} 条官方协议来源`);
  }
  const p = await loadParser();
  if (["dict", "import"].includes(command))
    console.log(JSON.stringify(await writeArtifacts(p), null, 2));
  else if (command === "update-parser") {
    const updater = new ParserUpdater(p);
    const result = await updater.check();
    console.log(JSON.stringify(result, null, 2));
    await updater.close();
    if (result.status === "failed") process.exitCode = 1;
  } else if (command === "audit-raw") {
    const raw = option("--raw", process.env.RAW_PROTO_DIR);
    if (!raw) throw new Error("请通过 --raw 指定只读样本目录");
    const report = await auditRaw(p, raw, {
      output: option("--output", path.join(paths.output, "external-audit")),
      progress: (s) => console.log(JSON.stringify(s)),
    });
    const existing = (await import("./dictionary.js")).readObservations;
    const observations = await existing();
    for (const [type, ids] of Object.entries(report.observations))
      observations[type] = [
        ...new Set([...(observations[type] || []), ...ids]),
      ];
    await writeArtifacts(p, observations);
    console.log(
      JSON.stringify(
        {
          packets: report.packets,
          decoded: report.decoded,
          failed: report.failed,
          unknown: report.unknown,
          methods: Object.keys(report.methods).length,
        },
        null,
        2,
      ),
    );
  } else if (command === "watch-raw") {
    const directory = option("--raw", process.env.RAW_PROTO_DIR);
    if (!directory) throw new Error("请通过 --raw 指定只读样本目录");
    const source = new RawSource(p);
    source.on("packet", (packet) => console.log(JSON.stringify(packet)));
    source.on("failure", (e) => console.error(JSON.stringify(e)));
    await source.start({ directory });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => source.stop().then(() => process.exit(0)));
  } else if (command === "offline")
    console.log(
      JSON.stringify(
        await runOffline(p, {
          capture: option("--capture", paths.capture),
          raw: option("--raw", paths.raw_packets),
        }),
        null,
        2,
      ),
    );
  else if (command === "verify") {
    const a = {
      proto: await fs.readFile(
        path.join(paths.proto_dump, "live_debug_snapshot.proto"),
        "utf8",
      ),
      dictionary: JSON.parse(
        await fs.readFile(path.join(paths.dist, "proto.dict"), "utf8"),
      ),
    };
    console.log(JSON.stringify(validateArtifacts(p, a), null, 2));
  } else if (command === "serve") {
    const app = await createWorkbench(p);
    console.log(`工作台已启动：${app.url}`);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => app.close().then(() => process.exit(0)));
  } else
    throw new Error(
      "支持命令：serve / import / dict / offline / verify / update-parser / audit-raw / watch-raw",
    );
} catch (e) {
  console.error(`执行失败：${e.message}`);
  process.exitCode = 1;
}
