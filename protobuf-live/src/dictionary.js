import fs from "node:fs/promises";
import path from "node:path";
import protobuf from "protobufjs";
import { paths } from "./paths.js";
import {
  messageComment,
  fieldComment,
  enumComment,
  valueComment,
} from "./comments.js";

export function buildArtifacts(p, observations = {}) {
  const dictionary = {};
  for (const [name, t] of [...p.types].sort(([a], [b]) =>
    a.localeCompare(b, "en"),
  )) {
    const ids = observations[name] || [];
    dictionary[name] = {
      msg_type_id: ids.length === 1 ? ids[0] : 0,
      desc: messageComment(t),
      fields: t.fields.map((f) => ({
        field_name: f.name,
        field_number: f.id,
        proto_type: f.keyType ? `map<${f.keyType}, ${f.type}>` : f.type,
        is_repeated: !!f.repeated,
        is_nested: p.types.has(f.type),
        comment: fieldComment(t, f),
        ...(f.keyType ? { is_map: true, map_key_type: f.keyType } : {}),
        ...(Object.entries(t.oneofs || {}).find(([, names]) =>
          names.includes(f.name),
        )
          ? {
              oneof: Object.entries(t.oneofs).find(([, names]) =>
                names.includes(f.name),
              )[0],
            }
          : {}),
      })),
      enums: { comment: "本消息嵌套枚举及归档于本项的同命名空间枚举" },
      msg_type_id_source: ids.length
        ? "样本信封 msg_type；可能多个类型共享该值"
        : "未知：官方结构无唯一类型编号，0 为未知占位",
      observed_msg_type_ids: ids,
    };
  }
  for (const e of [...p.enums.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName, "en"),
  )) {
    let parent = e.fullName.split(".").slice(0, -1).join(".");
    const owner = dictionary[parent]
      ? parent
      : Object.keys(dictionary).find((n) => n.startsWith(`${parent}.`));
    if (!owner) throw new Error(`枚举 ${e.fullName} 没有可归档消息`);
    const d = dictionary[owner];
    d.enum_comments ||= {};
    d.enum_value_comments ||= {};
    d.enum_comments[e.fullName] = enumComment(e);
    for (const [n, v] of Object.entries(e.values)) {
      const key = `${e.fullName}.${n}`;
      d.enums[key] = v;
      d.enum_value_comments[key] = valueComment(n);
    }
  }
  const lines = [
    'syntax = "proto3"; // 标准第三版协议语法',
    "// 来源为官方运行时；命名空间以容器消息表示，保持所有类型全名。",
    "// 中文业务注释中的“名称推断”不代表已验证事实；枚举字段若被编译为整数则保留整数。",
    ...p.sources.map((s) => `// 官方来源：${s.file}；摘要：${s.sha256}`),
    "",
  ];
  function emit(node, depth = 0) {
    const indent = "  ".repeat(depth),
      full = node.fullName.replace(/^\./, "");
    if (node instanceof protobuf.Enum) {
      const e = p.enums.get(full);
      lines.push(`${indent}enum ${node.name} { // ${enumComment(e)}`);
      const vs = Object.entries(e.values).sort(
        (a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "en"),
      );
      if (new Set(vs.map((x) => x[1])).size !== vs.length)
        lines.push(
          `${indent}  option allow_alias = true; // 官方定义包含相同数值别名`,
        );
      if (!vs.some((x) => x[1] === 0))
        lines.push(
          `${indent}  ${node.name.toUpperCase()}_SNAPSHOT_UNSPECIFIED = 0; // 为标准 proto3 补充零值；此项不是官方定义`,
        );
      for (const [n, v] of [
        ...vs.filter((x) => x[1] === 0),
        ...vs.filter((x) => x[1] !== 0),
      ])
        lines.push(`${indent}  ${n} = ${v}; // ${valueComment(n)}`);
      lines.push(`${indent}} // 枚举结束`);
      return;
    }
    if (!(node instanceof protobuf.Root))
      lines.push(
        `${indent}message ${node.name} { // ${p.types.has(full) ? messageComment(p.types.get(full)) : "官方命名空间容器；用于保持完整类型路径，非线上业务消息"}`,
      );
    const fieldIndent = "  ".repeat(
      depth + (node instanceof protobuf.Root ? 0 : 1),
    );
    if (p.types.has(full)) {
      const t = p.types.get(full),
        oneofNames = new Set(Object.values(t.oneofs || {}).flat());
      const emitField = (f, prefix = "") =>
        lines.push(
          `${fieldIndent}${prefix}${f.keyType ? `map<${f.keyType}, ${p.scalar.has(f.type) ? f.type : `.${f.type}`}>` : `${f.repeated ? "repeated " : ""}${p.scalar.has(f.type) ? f.type : `.${f.type}`}`} ${f.name} = ${f.id}${!f.keyType && f.repeated && p.scalar.has(f.type) && !["string", "bytes"].includes(f.type) ? ` [packed = ${f.packed ? "true" : "false"}]` : ""}; // ${fieldComment(t, f)}`,
        );
      for (const f of t.fields) if (!oneofNames.has(f.name)) emitField(f);
      for (const [n, names] of Object.entries(t.oneofs || {})) {
        lines.push(
          `${fieldIndent}oneof ${n} { // 官方互斥字段组；同组字段只保留当前选择`,
        );
        for (const f of t.fields.filter((f) => names.includes(f.name)))
          emitField(f, "  ");
        lines.push(`${fieldIndent}} // 互斥字段组结束`);
      }
    }
    for (const child of [...(node.nestedArray || [])].sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    ))
      emit(child, depth + (node instanceof protobuf.Root ? 0 : 1));
    if (!(node instanceof protobuf.Root))
      lines.push(`${indent}} // 消息或命名空间结束`);
  }
  emit(p.root);
  return { proto: lines.join("\n") + "\n", dictionary };
}
export function validateArtifacts(p, a) {
  const root = protobuf.parse(a.proto, { keepCase: true }).root;
  root.resolveAll();
  for (const t of p.types.values()) {
    const fields = root.lookupType(t.fullName).fields;
    if (Object.keys(fields).length !== t.fields.length)
      throw new Error(`${t.fullName} 字段数不一致`);
    for (const f of t.fields)
      if (
        fields[f.name]?.id !== f.id ||
        fields[f.name].type.replace(/^\./, "") !== f.type ||
        !!fields[f.name].map !== !!f.keyType ||
        !!fields[f.name].repeated !== !!f.repeated
      )
        throw new Error(`${t.fullName}.${f.name} 快照结构不一致`);
    const d = a.dictionary[t.fullName];
    if (
      !d ||
      !/[\u4e00-\u9fff]/.test(d.desc) ||
      !Number.isInteger(d.msg_type_id) ||
      d.fields.length !== t.fields.length
    )
      throw new Error(`${t.fullName} 字典消息不完整`);
    for (const f of t.fields) {
      const df = d.fields.find((v) => v.field_name === f.name);
      if (
        !df ||
        df.field_number !== f.id ||
        df.proto_type !==
          (f.keyType ? `map<${f.keyType}, ${f.type}>` : f.type) ||
        df.is_repeated !== !!f.repeated ||
        df.is_nested !== p.types.has(f.type) ||
        !/[\u4e00-\u9fff]/.test(df.comment)
      )
        throw new Error(`${t.fullName}.${f.name} 字典字段不一致或缺少注释`);
    }
  }
  for (const e of p.enums.values())
    for (const [n, v] of Object.entries(e.values)) {
      const key = `${e.fullName}.${n}`;
      if (
        !Object.values(a.dictionary).some(
          (d) =>
            d.enums[key] === v &&
            /[\u4e00-\u9fff]/.test(d.enum_comments?.[e.fullName] || "") &&
            /[\u4e00-\u9fff]/.test(d.enum_value_comments?.[key] || ""),
        )
      )
        throw new Error(`字典遗漏枚举 ${key}`);
    }
  return {
    messages: p.types.size,
    enums: p.enums.size,
    fields: [...p.types.values()].reduce((s, t) => s + t.fields.length, 0),
  };
}
export async function readObservations(
  file = path.join(paths.dist, "proto.dict"),
) {
  try {
    const d = JSON.parse(await fs.readFile(file, "utf8"));
    return Object.fromEntries(
      Object.entries(d)
        .filter(([, v]) => v.observed_msg_type_ids?.length)
        .map(([k, v]) => [k, v.observed_msg_type_ids.filter(Number.isInteger)]),
    );
  } catch {
    return {};
  }
}
export async function writeArtifacts(p, observations = null) {
  observations ||= await readObservations();
  const a = buildArtifacts(p, observations),
    stats = validateArtifacts(p, a);
  await fs.mkdir(paths.dist, { recursive: true });
  await fs.mkdir(paths.proto_dump, { recursive: true });
  await fs.writeFile(
    path.join(paths.dist, "proto.dict.tmp"),
    JSON.stringify(a.dictionary, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(paths.proto_dump, "live_debug_snapshot.proto.tmp"),
    a.proto,
  );
  await fs.rename(
    path.join(paths.dist, "proto.dict.tmp"),
    path.join(paths.dist, "proto.dict"),
  );
  await fs.rename(
    path.join(paths.proto_dump, "live_debug_snapshot.proto.tmp"),
    path.join(paths.proto_dump, "live_debug_snapshot.proto"),
  );
  return stats;
}
