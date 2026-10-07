import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import * as walk from "acorn-walk";
import protobuf from "protobufjs";
import { paths } from "./paths.js";

const scalar = new Set([
  "double",
  "float",
  "int32",
  "uint32",
  "sint32",
  "fixed32",
  "sfixed32",
  "int64",
  "uint64",
  "sint64",
  "fixed64",
  "sfixed64",
  "bool",
  "string",
  "bytes",
]);
function property(n) {
  return n?.computed ? n.property.value : n?.property?.name;
}
function inferRead(n) {
  if (n?.type !== "CallExpression") return null;
  const p = property(n.callee);
  if (scalar.has(p)) return p;
  if (p?.endsWith("String") && scalar.has(p.slice(0, -6)))
    return p.slice(0, -6);
  if (p === "decode") {
    const names = [];
    let v = n.callee.object;
    while (v?.type === "MemberExpression") {
      names.unshift(property(v));
      v = v.object;
    }
    return names.join(".");
  }
  return null;
}

// 从官方 decode 的 map 分支恢复被独立编译的字段，不猜测编号。
function readMaps(fn) {
  const ast = parse(`(${fn.toString()})`, { ecmaVersion: "latest" });
  const maps = [];
  walk.fullAncestor(ast, (n, _s, ancestors) => {
    if (
      n.type !== "AssignmentExpression" ||
      n.left.type !== "MemberExpression" ||
      n.left.object.type !== "MemberExpression"
    )
      return;
    const field = property(n.left.object);
    if (!field) return;
    const keyNode =
      n.left.property.type === "ConditionalExpression"
        ? n.left.property.alternate
        : n.left.property;
    if (keyNode.type !== "Identifier") return;
    const keyVar = keyNode.name;
    const valueVar = n.right.type === "Identifier" ? n.right.name : null;
    if (!valueVar) return;
    const branch = [...ancestors]
      .reverse()
      .find(
        (a) =>
          (a.type === "IfStatement" &&
            a.test.type === "BinaryExpression" &&
            [a.test.left, a.test.right].some(
              (v) => v.type === "Literal" && Number.isInteger(v.value),
            )) ||
          (a.type === "SwitchCase" && Number.isInteger(a.test?.value)),
      );
    if (!branch) return;
    const id =
      branch.type === "SwitchCase"
        ? branch.test.value
        : [branch.test.left, branch.test.right].find(
            (v) => v.type === "Literal",
          ).value;
    const reads = {};
    walk.simple(branch, {
      AssignmentExpression(a) {
        if (
          a.left.type === "Identifier" &&
          [keyVar, valueVar].includes(a.left.name)
        ) {
          const t = inferRead(a.right);
          if (t) reads[a.left.name] = t;
        }
      },
    });
    if (reads[keyVar] && reads[valueVar])
      maps.push({
        name: field,
        id,
        keyType: reads[keyVar],
        type: reads[valueVar],
      });
  });
  return maps;
}

function instrument(source) {
  const ast = parse(source, { ecmaVersion: "latest" });
  const edits = [];
  walk.simple(ast, {
    ObjectExpression(n) {
      if (
        !n.properties.length ||
        !n.properties.every(
          (p) =>
            p.type === "Property" &&
            /^\d+$/.test(String(p.key.value ?? p.key.name)) &&
            p.value.type === "ArrayExpression" &&
            p.value.elements.length === 3 &&
            typeof p.value.elements[0]?.value === "string",
        )
      )
        return;
      edits.push([n.start, "__capture("], [n.end, ")"]);
    },
  });
  edits.sort((a, b) => b[0] - a[0]);
  for (const [i, s] of edits) source = source.slice(0, i) + s + source.slice(i);
  return source;
}

const cached = new Map();
export function forgetParser(
  directory = process.env.PARSER_DIR || paths.vendor,
) {
  cached.delete(path.resolve(directory));
}
export function loadParser(
  directory = process.env.PARSER_DIR || paths.vendor,
  { fresh = false } = {},
) {
  directory = path.resolve(directory);
  if (fresh) return loadParserUncached(directory);
  if (!cached.has(directory))
    cached.set(
      directory,
      loadParserUncached(directory).catch((e) => {
        cached.delete(directory);
        throw e;
      }),
    );
  return cached.get(directory);
}
async function loadParserUncached(directory) {
  const names = (await fs.readdir(directory))
    .filter((n) => /(?:live-schema|transport-schema).*\.js$/.test(n))
    .sort();
  if (!names.length) return loadReflectedParser(directory);
  for (const role of ["live-schema", "transport-schema"])
    if (names.filter((n) => n.startsWith(role)).length > 1)
      throw new Error(
        `${role} 存在多个版本；请移走旧文件或执行 npm run import 选择最新抓包版本`,
      );
  const types = new Map(),
    enums = new Map(),
    sources = [],
    captures = [];
  const modules = {},
    cache = {};
  const oneofGetters = new WeakMap();
  // 每个版本独立 roots/util，候选加载不得污染正在运行的旧版 Parser。
  const runtime = Object.create(protobuf);
  runtime.roots = {};
  runtime.util = { ...protobuf.util };
  const getOneof = runtime.util.oneOfGetter;
  runtime.util.oneOfGetter = (names) => {
    const getter = getOneof(names);
    oneofGetters.set(getter, [...names]);
    return getter;
  };
  for (const name of ["int64", "uint64", "sint64", "fixed64", "sfixed64"]) {
    protobuf.Reader.prototype[`${name}String`] ||= function () {
      return this[name]().toString();
    };
  }
  const chunks = [];
  chunks.push = (data) => {
    Object.assign(modules, data[1]);
    return 1;
  };
  const sandbox = {
    self: { webpackChunkdouyin_live_v2: chunks },
    __capture(t) {
      captures.push(t);
      return t;
    },
  };
  sandbox.window = sandbox.self;
  const context = vm.createContext(sandbox);
  function req(id) {
    if (id === 110327) return runtime;
    if (cache[id]) return cache[id].exports;
    // 仅豁免已核验的编译辅助模块；196405 为未使用的对象展开/异步辅助导出。
    // 未知裸导入不代表可省略，必须拒绝候选以免静默缺少运行时行为。
    if (!modules[id] && [543963, 689925, 196405].includes(Number(id)))
      return {};
    if (!modules[id])
      throw new Error(
        `协议模块依赖 ${id} 未提供；请替换完整官方 Parser bundle`,
      );
    const mod = (cache[id] = { exports: {} });
    modules[id](mod, mod.exports, req);
    return mod.exports;
  }
  req.r = (e) => Object.defineProperty(e, "__esModule", { value: true });
  req.d = (e, d) => {
    for (const [k, get] of Object.entries(d))
      Object.defineProperty(e, k, { enumerable: true, get });
  };
  for (const name of names) {
    const source = await fs.readFile(path.join(directory, name), "utf8");
    sources.push({
      file: name,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    new vm.Script(instrument(source), { filename: name }).runInContext(
      context,
      { timeout: 15000 },
    );
  }
  function visit(obj, prefix = "") {
    for (const [name, v] of Object.entries(obj)) {
      if (
        [
          "decode",
          "encode",
          "getTypeUrl",
          "toObject",
          "fromObject",
          "create",
          "verify",
        ].includes(name)
      )
        continue;
      const full = prefix ? `${prefix}.${name}` : name;
      if (typeof v === "function" && typeof v.decode === "function") {
        types.set(full, { fullName: full, original: v, fields: [] });
        visit(v, full);
      } else if (v && typeof v === "object") {
        const values = Object.fromEntries(
          Object.entries(v).filter(
            ([k, x]) => !/^-?\d+$/.test(k) && Number.isInteger(x),
          ),
        );
        if (
          Object.keys(values).length &&
          Object.keys(v).every(
            (k) => typeof v[k] === "number" || typeof v[k] === "string",
          )
        )
          enums.set(full, { fullName: full, values });
        else visit(v, full);
      }
    }
  }
  try {
    for (const id of Object.keys(modules)) {
      const m = req(id);
      if (m.default) visit(m.default);
    }
  } finally {
    runtime.util.oneOfGetter = getOneof;
  }
  const decoders = new Map(
    [...types.values()].map((t) => [t.original.decode, t.fullName]),
  );
  const readers = new Map();
  for (const s of scalar)
    for (const reader of [protobuf.Reader, protobuf.BufferReader].filter(
      Boolean,
    ))
      for (const n of [s, `${s}String`])
        if (reader.prototype[n]) readers.set(reader.prototype[n], s);
  const missingFields = [];
  for (const t of types.values()) {
    t.oneofs = Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(t.original.prototype))
        .filter(([, d]) => d.get && oneofGetters.has(d.get))
        .map(([n, d]) => [n, oneofGetters.get(d.get)]),
    );
    captures.length = 0;
    t.original.decode(Buffer.alloc(0));
    for (const table of captures)
      for (const [id, [name, read, flags]] of Object.entries(table)) {
        const type = flags & 1 ? decoders.get(read) : readers.get(read);
        if (!type) throw new Error(`${t.fullName}.${name} 读取类型未识别`);
        t.fields.push({
          name,
          id: Number(id),
          type,
          repeated: !!(flags & 2),
          packed: !!(flags & 4),
        });
      }
    t.fields.push(...readMaps(t.original.decode));
    t.fields.sort((a, b) => a.id - b.id);
    for (const name of Object.keys(t.original.prototype))
      if (!t.fields.some((f) => f.name === name))
        missingFields.push(`${t.fullName}.${name}`);
  }
  if (!types.size)
    throw new Error(
      "未找到官方 live-schema / transport-schema JS；执行 npm run import 或设置 PARSER_DIR",
    );
  if (missingFields.length)
    throw new Error(
      `官方 Parser 存在未归档字段：${missingFields.slice(0, 15).join(", ")}`,
    );
  const root = new protobuf.Root();
  for (const t of types.values()) {
    const parts = t.fullName.split(".");
    let parent = root;
    for (const n of parts.slice(0, -1)) {
      let c = parent.get(n);
      if (!c)
        parent.add(
          (c = types.has([...parts.slice(0, parts.indexOf(n) + 1)].join("."))
            ? new protobuf.Type(n)
            : new protobuf.Namespace(n)),
        );
      parent = c;
    }
    if (!parent.get(parts.at(-1))) parent.add(new protobuf.Type(parts.at(-1)));
  }
  for (const e of enums.values()) {
    const a = e.fullName.split(".");
    const parent = root.lookup(a.slice(0, -1).join("."));
    parent.add(new protobuf.Enum(a.at(-1), e.values));
  }
  for (const t of types.values()) {
    const type = root.lookupType(t.fullName);
    for (const f of t.fields)
      type.add(
        f.keyType
          ? new protobuf.MapField(
              f.name,
              f.id,
              f.keyType,
              scalar.has(f.type) ? f.type : `.${f.type}`,
            )
          : new protobuf.Field(
              f.name,
              f.id,
              scalar.has(f.type) ? f.type : `.${f.type}`,
              f.repeated ? "repeated" : undefined,
              { packed: f.packed },
            ),
      );
    for (const [n, fields] of Object.entries(t.oneofs))
      type.add(new protobuf.OneOf(n, fields));
  }
  root.resolveAll();
  return { root, types, enums, sources, missingFields, scalar };
}

async function loadReflectedParser(directory) {
  const file = path.join(directory, "official-parser.js");
  let source;
  try {
    source = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(
      "没有官方 Parser：放入 live-schema/transport-schema JS 或导出反射 Root 的 official-parser.js",
    );
  }
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    protobuf,
    Buffer,
    Uint8Array,
    require(name) {
      if (name === "protobufjs") return protobuf;
      throw new Error(
        `反射 Parser 不支持依赖 ${name}；请导出自包含官方 descriptor`,
      );
    },
    self: {},
  };
  sandbox.window = sandbox.self;
  new vm.Script(source, { filename: file }).runInNewContext(sandbox, {
    timeout: 15000,
  });
  const exported = mod.exports;
  const candidate = [
    exported,
    exported.root,
    exported.default,
    exported.descriptor,
    sandbox.self.__PROTO_ROOT__,
  ].find((v) => v && (typeof v.toJSON === "function" || v.nested));
  if (!candidate)
    throw new Error(
      "official-parser.js 未导出完整 Root/descriptor；禁止用缺失结构的 decode 函数猜测协议",
    );
  const root = protobuf.Root.fromJSON(
    typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate,
  ).resolveAll();
  const types = new Map(),
    enums = new Map();
  function visit(node) {
    const fullName = node.fullName.replace(/^\./, "");
    if (node instanceof protobuf.Type)
      types.set(fullName, {
        fullName,
        original: {
          decode: (bytes) => node.decode(bytes),
          encode: (obj) => node.encode(node.fromObject(obj)),
        },
        fields: node.fieldsArray
          .map((f) => ({
            name: f.name,
            id: f.id,
            type: f.resolvedType
              ? f.resolvedType.fullName.replace(/^\./, "")
              : f.type,
            repeated: f.repeated,
            packed: f.packed,
            keyType: f.map ? f.keyType : undefined,
            optional: f.options?.proto3_optional === true,
          }))
          .sort((a, b) => a.id - b.id),
        oneofs: Object.fromEntries(
          (node.oneofsArray || []).map((o) => [o.name, [...o.oneof]]),
        ),
      });
    if (node instanceof protobuf.Enum)
      enums.set(fullName, { fullName, values: { ...node.values } });
    for (const child of node.nestedArray || []) visit(child);
  }
  visit(root);
  if (!types.size) throw new Error("反射 Root 没有消息结构");
  return {
    root,
    types,
    enums,
    scalar,
    missingFields: [],
    sources: [
      {
        file: "official-parser.js",
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ],
  };
}
