import { connectPreview } from "/plugins.js";

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
let activeMode = null;
let rawDirectory = "",
  previousMode = "browser",
  batchState = null;
const modeTargets = {};
const labels = {
  stopped: "未连接",
  connecting: "正在连接",
  connected: "已连接",
  waiting: "等待恢复",
  blocked: "需要检查",
  scanning: "正在扫描",
  running: "正在解析",
  saving: "正在保存",
  completed: "解析完成",
  cancelled: "已停止解析",
  failed: "解析失败",
};
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = "notice" + (error ? " error" : "");
}
function loginStatus(login) {
  $("login-status").textContent = login.configured
    ? (login.browser_state ? "会话配置已保存" : "已配置 Cookie") +
      (login.saved_at
        ? " · " + new Date(login.saved_at).toLocaleString("zh-CN")
        : "")
    : "尚未保存登录态 · Cookie 从本地 .env 读取";
}
function accountStatus(
  account = {
    state: "unknown",
    user: null,
    reason: "等待服务返回当前账号状态",
  },
) {
  const states = {
    inactive: "浏览器未打开",
    checking: "正在检测账号",
    unknown: "账号待确认",
    authenticated: "已登录",
    anonymous: "访客 · 未登录",
    error: "登录态检测失败",
  };
  $("account-state").textContent = states[account.state] || "账号待确认";
  const user = account.user;
  $("account-info").textContent = user
    ? `${user.nickname}${user.account ? " · 抖音号 " + user.account : ""} · UID ${user.id}`
    : "未获取到当前登录账号";
  const avatar = $("account-avatar");
  avatar.hidden = !user?.avatar;
  if (user?.avatar) avatar.src = user.avatar;
  else avatar.removeAttribute("src");
  $("account-detail").textContent =
    (account.reason || "") +
    (account.checked_at
      ? " · " + new Date(account.checked_at).toLocaleTimeString("zh-CN")
      : "");
  $("check-login").disabled = account.state === "checking";
}
$("check-login").onclick = async () => {
  $("check-login").disabled = true;
  try {
    accountStatus(await api("/api/check-login", {}));
  } catch (e) {
    notice(e.message, true);
  } finally {
    $("check-login").disabled = false;
  }
};
$("account-avatar").onerror = () => {
  $("account-avatar").hidden = true;
};
$("save-login").onclick = async () => {
  $("save-login").disabled = true;
  notice("正在重新确认账号并保存；查询冷却期间可能需要等待约 15 秒。");
  try {
    loginStatus(await api("/api/save-login", {}));
    notice("登录态已保存到本地配置。后续连接自动读取；配置不会提交到 Git。");
  } catch (e) {
    notice(e.message, true);
  } finally {
    $("save-login").disabled = false;
  }
};
function status(s) {
  if (s.session_id && s.state !== "stopped") {
    preview.begin(s.session_id);
    if (!preview.paused) $("preview-state").textContent = "跟随消息展示";
  }
  activeMode = s.state === "stopped" ? null : s.mode || activeMode;
  $("connection").textContent = labels[s.state] || s.state;
  $("connection").className = "status " + s.state;
  if (s.reason) notice(s.reason, s.state === "blocked");
  if (s.state === "connected") notice("已连接。接收消息并保存完整 JSON 日志。");
  if (s.mode === "browser")
    $("account-flow").textContent =
      `WebCast 帧 ${s.received || 0} · 业务消息 ${s.business_messages || 0}${s.last_packet_at ? " · 最后收包 " + new Date(s.last_packet_at).toLocaleTimeString("zh-CN") : ""}`;
  if (s.mode === "raw-batch") batchProgress(s);
}
function batchProgress(s) {
  batchState = s;
  if (s.state === "stopped") return;
  $("batch-panel").hidden = false;
  $("batch-state").textContent = labels[s.state] || s.state;
  const progress = $("batch-progress");
  if (s.state === "scanning") progress.removeAttribute("value");
  else {
    progress.max = Math.max(s.total || 0, 1);
    progress.value =
      s.total === 0 && s.state === "completed" ? 1 : s.processed || 0;
  }
  $("batch-files").textContent =
    s.total == null
      ? `已找到 ${(s.scanned || 0).toLocaleString()}`
      : `${(s.processed || 0).toLocaleString()} / ${s.total.toLocaleString()}`;
  $("batch-decoded").textContent = (s.decoded || 0).toLocaleString();
  $("batch-failed").textContent = (s.failed || 0).toLocaleString();
  $("batch-unknown").textContent = (s.unknown || 0).toLocaleString();
  $("batch-download").hidden = !["completed", "cancelled"].includes(s.state);
  $("batch-output").textContent = s.output
    ? `结果保存至：${s.output}`
    : "源目录只读";
  if (activeMode === "raw-batch") {
    if (s.reason) notice(s.reason, true);
    else if (s.state === "completed")
      notice("批量解析完成，完整 JSON 与报告已保存，双协议产物已更新。");
    else if (s.state === "cancelled")
      notice("批量解析已停止，已完成部分的结果已保存。");
    $("message-count").textContent = (
      (s.decoded || 0) +
      (s.failed || 0) +
      (s.unknown || 0)
    ).toLocaleString();
    $("error-count").textContent = (s.failed || 0).toLocaleString();
    $("rate").textContent =
      s.state === "running" ? "批量解析已有文件" : labels[s.state] || s.state;
    $("start").disabled = ["scanning", "running", "saving"].includes(s.state);
  }
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
const preview = connectPreview((message) =>
  show({
    ...message,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  }),
);
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
        directory: ["raw", "raw-batch"].includes(mode) ? target : undefined,
        visible: $("visible").checked,
        modern: $("modern").checked,
      }),
    );
  } catch (e) {
    notice(e.message, true);
  } finally {
    $("start").disabled =
      batchState &&
      ["scanning", "running", "saving"].includes(batchState.state);
  }
};
$("stop").onclick = async () => {
  try {
    status(await api("/api/stop", {}));
    notice(
      $("mode").value === "raw-batch"
        ? "批量任务已停止，已完成部分的结果已保存。"
        : "观察已停止，日志已保存。",
    );
  } catch (e) {
    notice(e.message, true);
  }
};
$("mode").onchange = () => {
  modeTargets[previousMode] = $("target").value;
  previousMode = $("mode").value;
  const direct = $("mode").value === "direct";
  const batch = $("mode").value === "raw-batch";
  const raw = ["raw", "raw-batch"].includes($("mode").value);
  $("target").value = modeTargets[previousMode] || (raw ? rawDirectory : "");
  $("start").textContent = batch ? "开始解析" : "开始观察";
  $("connection-hint").textContent = raw
    ? "本地文件 · 源目录只读"
    : "单房间 · 30 秒连接冷却";
  if (!batchState || batchState.state === "stopped")
    $("batch-panel").hidden = !batch;
  notice(
    batch
      ? "输入 rawproto 文件夹路径，批量解析已有 .bin 文件；源文件保持只读。"
      : raw
        ? "只读监听目录中新写入的 .bin；已有文件请选择批量解析模式。"
        : "输入直播间或当前有效的 WSS 地址。",
  );
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
  rawDirectory = session.raw_directory || "";
  loginStatus(session.login);
  accountStatus(session.account);
  if (["raw", "raw-batch"].includes(session.status.mode)) {
    $("mode").value = session.status.mode;
    modeTargets[session.status.mode] = session.status.directory || rawDirectory;
    $("mode").onchange();
  }
  if (session.status.mode === "browser" && session.status.room_url)
    $("target").value = session.status.room_url;
  status(session.status);
  if (session.batch && session.batch.state !== "stopped")
    batchProgress(session.batch);
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
  events.addEventListener("login", (e) => loginStatus(JSON.parse(e.data)));
  events.addEventListener("account", (e) => accountStatus(JSON.parse(e.data)));
  events.addEventListener("status", (e) => status(JSON.parse(e.data)));
  events.addEventListener("batch-progress", (e) =>
    batchProgress(JSON.parse(e.data)),
  );
  events.addEventListener("parser-update", (e) =>
    updateStatus(JSON.parse(e.data)),
  );
  events.addEventListener("barrage", (e) => {
    const b = JSON.parse(e.data);
    preview.barrage(b, {
      method: b.method,
      type: b.type,
      msg_id: b.message_id,
      status: "decoded",
      data: b.data,
    });
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
    if (activeMode === "browser")
      $("account-flow").textContent =
        "工作台正在收包 · 最新帧 " +
        new Date(packet.received_at).toLocaleTimeString("zh-CN");
    preview.packet(packet);
    for (const m of packet.messages || []) {
      if (packet.kind !== "batch-preview") {
        received++;
        if (m.status === "error") errors++;
      }
      messages.unshift({
        ...m,
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      });
    }
    messages = messages.slice(0, 200);
    if (packet.kind !== "batch-preview") {
      $("message-count").textContent = received.toLocaleString();
      $("error-count").textContent = errors;
      $("rate").textContent = "持续写入本地日志";
    }
    if (!paused) render();
  });
  events.onerror = () => notice("工作台连接中断，正在恢复页面连接。", true);
}
init().catch((e) => notice(e.message, true));
