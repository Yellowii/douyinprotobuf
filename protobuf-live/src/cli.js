import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.js";
import { loadParser } from "./parser.js";
import { writeArtifacts, validateArtifacts } from "./dictionary.js";
import { runOffline } from "./offline.js";
import { importParsers } from "./har.js";
import { createWorkbench } from "./server.js";
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
  else if (command === "offline")
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
  } else throw new Error("支持命令：serve / import / dict / offline / verify");
} catch (e) {
  console.error(`执行失败：${e.message}`);
  process.exitCode = 1;
}
