const $ = (id) => document.getElementById(id);
let token = "",
  messages = [],
  paused = false,
  received = 0,
  errors = 0,
  selected = null,
  types = [],
  schemaRequest = 0;
let barrageCount = 0;
const labels = {
  stopped: "未连接",
  connecting: "正在连接",
  connected: "已连接",
  waiting: "等待恢复",
  blocked: "需要检查",
};
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = "notice" + (error ? " error" : "");
}
function status(s) {
  $("connection").textContent = labels[s.state] || s.state;
  $("connection").className = "status " + s.state;
  if (s.reason) notice(s.reason, s.state === "blocked");
  if (s.state === "connected") notice("已连接。接收消息并保存完整 JSON 日志。");
}
async function api(url, body) {
  const r = await fetch(url, {
    ...(body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-workbench-token": token,
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "请求失败");
  return data;
}
function summary(m) {
  const d = m.data || {};
  const user = d.user?.nickname || d.user?.nick_name || d.user?.nickName || "";
  return (
    [
      user,
      d.content ||
        d.describe ||
        d.display_text?.default_pattern ||
        d.gift?.name ||
        (d.count != null ? `数量 ${d.count}` : ""),
    ]
      .filter(Boolean)
      .join(" · ") || m.method
  );
}
function show(m) {
  selected = m;
  $("detail").textContent = JSON.stringify(m, null, 2);
  $("detail-label").textContent = m.type || m.method;
  render();
  if (m.type) {
    $("schema-search").value = m.type;
    loadSchema(m.type);
  }
}
function render() {
  const filter = $("filter").value.toLowerCase();
  const visible = messages.filter((m) =>
    (m.method + " " + summary(m)).toLowerCase().includes(filter),
  );
  $("shown-count").textContent = visible.length;
  const feed = $("feed");
  feed.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = messages.length ? "没有匹配的消息" : "等待直播消息…";
    feed.append(empty);
    return;
  }
  for (const m of visible) {
    const row = document.createElement("button");
    row.className = "message-row" + (selected === m ? " selected" : "");
    for (const [value, className] of [
      [m.time, "time"],
      [m.method.replace(/^Webcast/, ""), "type"],
      [summary(m), ""],
      [
        m.status === "decoded"
          ? "正常"
          : m.status === "unknown"
            ? "未知"
            : "异常",
        m.status,
      ],
    ]) {
      const span = document.createElement("span");
      span.textContent = value;
      span.className = className;
      span.title = value;
      row.append(span);
    }
    row.onclick = () => show(m);
    feed.append(row);
  }
}
async function loadSchema(name) {
  const id = ++schemaRequest;
  try {
    const schema = await api("/api/schema?name=" + encodeURIComponent(name));
    if (id !== schemaRequest) return;
    $("schema-desc").textContent = schema.desc;
    $("schema-fields").replaceChildren();
    for (const f of schema.fields) {
      const tr = document.createElement("tr");
      for (const v of [
        f.field_number,
        f.field_name,
        f.proto_type,
        f.is_map
          ? "映射"
          : f.is_repeated
            ? "重复列表"
            : f.oneof
              ? "互斥组 " + f.oneof
              : "单值",
        f.comment,
      ]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      $("schema-fields").append(tr);
    }
    $("schema-enums").textContent = Object.entries(schema.enum_comments || {})
      .map(([k, v]) => k + "：" + v)
      .join("\n");
  } catch (e) {
    $("schema-desc").textContent = e.message;
  }
}
$("connect-form").onsubmit = async (e) => {
  e.preventDefault();
  $("start").disabled = true;
  try {
    const mode = $("mode").value;
    const target = $("target").value.trim();
    status(
      await api("/api/start", {
        mode,
        roomUrl: mode === "browser" ? target : undefined,
        wss: mode === "direct" ? target : undefined,
        directory: mode === "raw" ? target : undefined,
        visible: $("visible").checked,
        modern: $("modern").checked,
      }),
    );
  } catch (e) {
    notice(e.message, true);
  } finally {
    $("start").disabled = false;
  }
};
$("stop").onclick = async () => {
  try {
    status(await api("/api/stop", {}));
    notice("观察已停止，日志已保存。");
  } catch (e) {
    notice(e.message, true);
  }
};
$("mode").onchange = () => {
  const direct = $("mode").value === "direct";
  const raw = $("mode").value === "raw";
  $("url-label").textContent = raw
    ? "原始包只读目录"
    : direct
      ? "当前有效的 WSS 地址"
      : "直播间地址";
  $("target").placeholder = raw
    ? "D:\\Proj\\LiveDash\\WssBarrageServer\\raw_proto"
    : direct
      ? "wss://webcast…douyin.com/webcast/im/push/v2/?…"
      : "https://live.douyin.com/房间号";
  $("visible").disabled = direct || raw;
  $("modern").disabled = !direct;
};
function updateStatus(s) {
  const names = {
    idle: "等待检查",
    checking: "正在检查",
    updated: "已更新",
    unchanged: "当前已是所发现的官方版本",
    failed: "检查失败，保留旧版",
    throttled: "检查冷却中",
  };
  $("update-status").textContent =
    (names[s.status] || s.status) +
    (s.checked_at
      ? " · " + new Date(s.checked_at).toLocaleString("zh-CN")
      : "");
  $("update-detail").textContent =
    (s.message || "") + (s.error ? "：" + s.error : "");
  $("update-parser").disabled = s.status === "checking";
}
$("update-parser").onclick = async () => {
  try {
    updateStatus({
      status: "checking",
      message: "正在检查官方模块并校验协议…",
    });
    updateStatus(await api("/api/parser-update", {}));
    const session = await api("/api/session");
    $("protocol-count").textContent = session.protocols.toLocaleString();
    $("field-count").textContent = session.fields.toLocaleString();
    types = await api("/api/schema");
    $("type-list").replaceChildren();
    for (const name of types) {
      const option = document.createElement("option");
      option.value = name;
      $("type-list").append(option);
    }
  } catch (e) {
    updateStatus({ status: "failed", message: e.message });
  }
};
$("mode").onchange();
$("filter").oninput = render;
$("pause").onclick = () => {
  paused = !paused;
  $("pause").textContent = paused ? "继续展示" : "暂停展示";
  if (!paused) render();
};
$("clear").onclick = () => {
  messages = [];
  render();
};
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("detail").textContent);
    notice("JSON 已复制。");
  } catch {
    notice("无法访问剪贴板，请选中详情手动复制。", true);
  }
};
$("schema-search").onchange = () => {
  const value = $("schema-search").value;
  const name =
    types.find((n) => n === value) ||
    types.find((n) => n.split(".").at(-1) === value);
  if (name) loadSchema(name);
};
async function init() {
  const session = await api("/api/session");
  token = session.token;
  status(session.status);
  updateStatus(session.parser_update);
  $("protocol-count").textContent = session.protocols.toLocaleString();
  $("field-count").textContent = session.fields.toLocaleString();
  types = await api("/api/schema");
  for (const name of types) {
    const option = document.createElement("option");
    option.value = name;
    $("type-list").append(option);
  }
  const events = new EventSource("/events");
  events.addEventListener("status", (e) => status(JSON.parse(e.data)));
  events.addEventListener("parser-update", (e) =>
    updateStatus(JSON.parse(e.data)),
  );
  events.addEventListener("barrage", (e) => {
    const b = JSON.parse(e.data);
    barrageCount++;
    $("barrage-count").textContent = barrageCount.toLocaleString();
    const feed = $("barrage-feed");
    if (barrageCount === 1) feed.replaceChildren();
    const row = document.createElement("div");
    row.className = "barrage-row";
    const time = document.createElement("small");
    time.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const user = document.createElement("strong");
    user.textContent = b.user.nickname || "观众";
    const text = document.createElement("span");
    text.textContent =
      b.text ||
      (b.kind === "emoji"
        ? "[表情弹幕]"
        : b.kind === "audio"
          ? "[语音弹幕]"
          : "[屏幕弹幕]");
    row.append(time, user, text);
    row.onclick = () =>
      show({
        method: b.method,
        type: b.type,
        status: "decoded",
        data: b.data,
        time: time.textContent,
      });
    feed.prepend(row);
    while (feed.children.length > 100) feed.lastElementChild.remove();
  });
  events.addEventListener("failure", (e) => {
    errors++;
    $("error-count").textContent = errors;
    notice(JSON.parse(e.data).error, true);
  });
  events.addEventListener("packet", (e) => {
    const packet = JSON.parse(e.data);
    for (const m of packet.messages || []) {
      received++;
      if (m.status === "error") errors++;
      messages.unshift({
        ...m,
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      });
    }
    messages = messages.slice(0, 200);
    $("message-count").textContent = received.toLocaleString();
    $("error-count").textContent = errors;
    $("rate").textContent = "持续写入本地日志";
    if (!paused) render();
  });
  events.onerror = () => notice("工作台连接中断，正在恢复页面连接。", true);
}
init().catch((e) => notice(e.message, true));
