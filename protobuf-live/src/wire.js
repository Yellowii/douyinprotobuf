// 校验 Protobuf wire 边界，防止底层 BufferReader 对截断字符串静默切片。
// 未知字段按 wire type 跳过，不据此杜撰协议字段名或业务含义。
export function validateWire(bytes, parser = null, type = null, depth = 0) {
  if (depth > 80) throw new Error("Protobuf 嵌套层数超过限制");
  let pos = 0;
  const groups = [];
  const varint = () => {
    let value = 0,
      multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) throw new Error("截断的 Protobuf varint");
      const b = bytes[pos++];
      if (i === 9 && b > 1) throw new Error("Protobuf varint 超出 uint64");
      if (i < 5) value += (b & 127) * multiplier;
      if (!(b & 128)) return { value, length: i + 1 };
      multiplier *= 128;
    }
    throw new Error("无效 Protobuf varint");
  };
  const fields = type ? new Map(type.fields.map((f) => [f.id, f])) : null;
  while (pos < bytes.length) {
    const tag = varint();
    if (tag.length > 5 || tag.value > 0xffffffff)
      throw new Error("无效 Protobuf tag");
    const number = Math.floor(tag.value / 8),
      wire = tag.value % 8;
    if (!number) throw new Error("Protobuf 字段编号不能为 0");
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 2) {
      const length = varint();
      if (
        length.length > 5 ||
        length.value > 0xffffffff ||
        pos + length.value > bytes.length
      )
        throw new Error("截断的 Protobuf 长度字段");
      const field = fields?.get(number),
        nested = field && !field.keyType && parser?.types.get(field.type);
      if (nested)
        validateWire(
          bytes.subarray(pos, pos + length.value),
          parser,
          nested,
          depth + 1,
        );
      pos += length.value;
    } else if (wire === 3) {
      if (groups.length + depth >= 80)
        throw new Error("Protobuf group 嵌套过深");
      groups.push(number);
    } else if (wire === 4) {
      if (groups.pop() !== number) throw new Error("Protobuf group 不匹配");
    } else if (wire === 5) pos += 4;
    else throw new Error(`无效 Protobuf wire type ${wire}`);
    if (pos > bytes.length) throw new Error("截断的 Protobuf 定长字段");
  }
  if (groups.length) throw new Error("截断的 Protobuf group");
}
