import path from "node:path";
import { fileURLToPath } from "node:url";
export const BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const paths = Object.fromEntries(
  [
    "src/vendor",
    "samples/capture",
    "samples/raw_packets",
    "samples/proto_dump",
    "dist",
    "output",
    "static",
  ].map((x) => [x.split("/").at(-1), path.join(BASE, x)]),
);
