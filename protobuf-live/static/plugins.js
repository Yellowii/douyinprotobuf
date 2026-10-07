// 官方 CSS 保留原始内容；此展示适配器消费工作台 JSON，不执行抖音页面插件 JS。
const defaultSettings = {
  danmaku: true,
  gifts: true,
  font: "20",
  speed: "normal",
  opacity: "100",
};
const chatKinds = new Map([
  ["WebcastChatMessage", "text"],
  ["WebcastEmojiChatMessage", "emoji"],
  ["WebcastScreenChatMessage", "screen"],
  ["WebcastPrivilegeScreenChatMessage", "privilege"],
  ["WebcastAudioChatMessage", "audio"],
  ["WebcastExhibitionChatMessage", "exhibition"],
]);
const giftMethods = new Set([
  "WebcastGiftMessage",
  "WebcastBindingGiftMessage",
]);
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function integer(value, fallback = "1") {
  const text = String(value ?? "");
  return /^\d{1,20}$/.test(text) && BigInt(text) > 0n
    ? BigInt(text).toString()
    : fallback;
}
function settingsFromStorage() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("webcast-preview-settings"));
  } catch {}
  const result = { ...defaultSettings };
  if (saved?.danmaku === false) result.danmaku = false;
  if (saved?.gifts === false) result.gifts = false;
  if (["16", "20", "24"].includes(saved?.font)) result.font = saved.font;
  if (["slow", "normal", "fast"].includes(saved?.speed))
    result.speed = saved.speed;
  if (
    /^\d{2,3}$/.test(String(saved?.opacity)) &&
    +saved.opacity >= 30 &&
    +saved.opacity <= 100
  )
    result.opacity = String(saved.opacity);
  return result;
}

class WebcastPreview extends HTMLElement {
  constructor() {
    super();
    this.settings = settingsFromStorage();
    this.paused = false;
    this.gifts = new Map();
    this.seen = new Set();
    this.lane = 0;
    const root = this.attachShadow({ mode: "open" });
    for (const href of [
      "/plugin-styles/DanmakuPlugin.bf02df37.css",
      "/plugin-styles/GiftTrayPlugin.ad979c7b.css",
      "/plugins.css",
    ]) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      root.append(link);
    }
    this.stage = element("div", "stage");
    this.empty = element("div", "stage-empty");
    this.empty.append(
      element("strong", "", "直播互动预览"),
      element("span", "", "连接直播间或解析样本后，弹幕和礼物会在这里出现。"),
    );
    this.lines = element("div", "danmaku-layer");
    this.trays = element("div", "gift-layer");
    this.stage.append(this.empty, this.lines, this.trays);
    root.append(this.stage);
    this.apply();
  }
  connectedCallback() {
    this.timer = setInterval(() => this.sweep(), 1000);
    this.resizeObserver = new ResizeObserver(() => this.updateLayout());
    this.resizeObserver.observe(this.stage);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    this.resizeObserver?.disconnect();
    this.clear();
  }
  updateLayout() {
    const width = this.stage.clientWidth || 800;
    for (const line of this.lines.children)
      for (const animation of line.getAnimations())
        animation.effect.setKeyframes([
          { transform: `translateX(${width}px)` },
          { transform: `translateX(-${line.offsetWidth + 30}px)` },
        ]);
  }
  apply() {
    this.lines.hidden = !this.settings.danmaku;
    this.trays.hidden = !this.settings.gifts;
    this.trays.style.opacity = Number(this.settings.opacity) / 100;
    for (const line of this.lines.children) {
      line.style.fontSize = this.settings.font + "px";
      line.style.opacity = Number(this.settings.opacity) / 100;
    }
  }
  configure(values) {
    this.settings = { ...this.settings, ...values };
    try {
      localStorage.setItem(
        "webcast-preview-settings",
        JSON.stringify(this.settings),
      );
    } catch {}
    this.apply();
    if (values.font) this.updateLayout();
    if (values.speed)
      for (const line of this.lines.children)
        for (const animation of line.getAnimations()) {
          const progress = animation.effect.getComputedTiming().progress || 0;
          const duration = { slow: 16000, normal: 12000, fast: 8000 }[
            this.settings.speed
          ];
          animation.effect.updateTiming({ duration });
          animation.currentTime = duration * progress;
        }
  }
  pause(value) {
    this.paused = value;
    if (value) this.pausedAt = performance.now();
    else {
      const delta = performance.now() - this.pausedAt;
      for (const gift of this.gifts.values()) gift.expires += delta;
    }
    for (const line of this.lines.children)
      for (const animation of line.getAnimations())
        value ? animation.pause() : animation.play();
  }
  clear() {
    for (const line of this.lines.children)
      for (const animation of line.getAnimations()) animation.cancel();
    this.lines.replaceChildren();
    this.trays.replaceChildren();
    this.gifts.clear();
    this.seen.clear();
    this.empty.hidden = false;
  }
  begin(scope) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.clear();
  }
  sweep() {
    if (this.paused) return;
    for (const [key, gift] of this.gifts)
      if (gift.expires <= performance.now()) {
        gift.node.remove();
        this.gifts.delete(key);
      }
    this.empty.hidden = this.lines.children.length > 0 || this.gifts.size > 0;
  }
  select(message) {
    this.dispatchEvent(new CustomEvent("message-select", { detail: message }));
  }
  barrage(barrage, message) {
    if (this.paused || !this.settings.danmaku) return;
    const text =
      barrage.text ||
      (barrage.kind === "emoji"
        ? "[表情弹幕]"
        : barrage.kind === "audio"
          ? "[语音弹幕]"
          : "[屏幕弹幕]");
    const line = element(
      "button",
      "z2QtPUSr danmaku-line",
      `${barrage.user?.nickname || "观众"}：${text}`.slice(0, 400),
    );
    if (["screen", "privilege"].includes(barrage.kind))
      line.classList.add("Yx33DOc5");
    line.type = "button";
    line.title = "查看消息 JSON";
    line.style.fontSize = this.settings.font + "px";
    line.style.opacity = Number(this.settings.opacity) / 100;
    line.style.top = `${22 + (this.lane++ % 5) * 36}px`;
    line.onclick = () => this.select(message);
    this.lines.append(line);
    while (this.lines.children.length > 40) {
      const first = this.lines.firstElementChild;
      for (const animation of first.getAnimations()) animation.cancel();
      first.remove();
    }
    this.empty.hidden = true;
    const width = this.stage.clientWidth || 800;
    const duration = { slow: 16000, normal: 12000, fast: 8000 }[
      this.settings.speed
    ];
    const animation = line.animate(
      [
        { transform: `translateX(${width}px)` },
        { transform: `translateX(-${line.offsetWidth + 30}px)` },
      ],
      { duration, easing: "linear", fill: "forwards" },
    );
    animation.onfinish = () => {
      line.remove();
      this.sweep();
    };
  }
  gift(message) {
    if (
      this.paused ||
      !this.settings.gifts ||
      !giftMethods.has(message.method) ||
      message.status !== "decoded"
    )
      return;
    const d =
        (message.method === "WebcastBindingGiftMessage"
          ? message.data?.msg
          : message.data) || {},
      user = d.user || {},
      gift = d.gift || {};
    const count =
      [d.repeat_count, d.combo_count, d.group_count, d.count]
        .map((value) => integer(value, ""))
        .find(Boolean) || "1";
    const group = integer(d.group_id, "");
    const id = integer(message.msg_id, "") || integer(d.common?.msg_id, "");
    const dedupe = id && `${message.method}:${id}`;
    if (dedupe && this.seen.has(dedupe)) return;
    if (dedupe) this.seen.add(dedupe);
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.values().next().value);
    const key = group
      ? `${user.id || user.id_str || user.nickname || ""}:${d.gift_id || gift.id || ""}:${group}`
      : dedupe || Symbol();
    let tray = this.gifts.get(key);
    if (tray) {
      // repeat_count 是当前连击累计数量，不能把重复通知相加。
      if (BigInt(count) > BigInt(tray.count)) tray.count = count;
      tray.label.textContent = tray.count;
      tray.message = message;
      tray.expires = performance.now() + 8000;
      return;
    }
    const node = element("button", "L2b9fZRi gift-card");
    node.type = "button";
    node.title = "查看礼物消息 JSON";
    const body = element("div", "btjeRr_1");
    const avatar = element(
      "div",
      "jM0ftSmS gift-avatar",
      (user.nickname || "观众").slice(0, 1),
    );
    const info = element("div", "w7ExHwcb ZqLkBOva");
    const name = element("div", "R3NQhqW2");
    name.append(element("span", "P8WJFHfQ", user.nickname || "观众"));
    const action = element("div", "H1X5W105");
    action.append(
      element("span", "UYA_fu_6", `送出 ${gift.name || d.gift_name || "礼物"}`),
    );
    info.append(name, action);
    body.append(avatar, info, element("div", "rUafhWtz gift-symbol", "✦"));
    const amount = element("div", "H3d4pQzL");
    const amountText = element("div", "i2wdcJrD");
    const label = element("span", "PcBvEQw9 gift-count", count);
    amountText.append(element("span", "Mu_P4zFQ", "×"), label);
    amount.append(amountText);
    node.append(body, amount);
    tray = { node, label, count, message, expires: performance.now() + 8000 };
    node.onclick = () => this.select(tray.message);
    this.gifts.set(key, tray);
    this.trays.append(node);
    while (this.gifts.size > 3) {
      const first = this.gifts.keys().next().value;
      this.gifts.get(first).node.remove();
      this.gifts.delete(first);
    }
    this.empty.hidden = true;
  }
  packet(packet) {
    for (const message of packet.messages || []) {
      this.gift(message);
      const kind = chatKinds.get(message.method);
      // 实时消息已有标准化 barrage 事件；批量预览在此适配，避免重复展示。
      if (
        packet.kind === "batch-preview" &&
        kind &&
        message.status === "decoded"
      ) {
        const d = message.data || {};
        this.barrage(
          {
            kind,
            user: d.user || d.sender,
            text:
              d.content ||
              d.text ||
              d.chat_text ||
              d.default_content ||
              d.emoji_content?.default_pattern ||
              d.display_text?.default_pattern ||
              "",
          },
          message,
        );
      }
    }
  }
}
customElements.define("webcast-preview", WebcastPreview);

export function connectPreview(onSelect) {
  const $ = (id) => document.getElementById(id),
    preview = $("plugin-preview");
  preview.addEventListener("message-select", (event) => onSelect(event.detail));
  for (const [key, id] of Object.entries({
    danmaku: "preview-danmaku",
    gifts: "preview-gifts",
    font: "preview-font",
    speed: "preview-speed",
    opacity: "preview-opacity",
  })) {
    const control = $(id);
    if (control.type === "checkbox") control.checked = preview.settings[key];
    else control.value = preview.settings[key];
    const update = () => {
      preview.configure({
        [key]: control.type === "checkbox" ? control.checked : control.value,
      });
      $("preview-opacity-value").textContent = preview.settings.opacity + "%";
    };
    control.addEventListener(key === "opacity" ? "input" : "change", update);
  }
  $("preview-opacity-value").textContent = preview.settings.opacity + "%";
  $("preview-pause").onclick = () => {
    preview.pause(!preview.paused);
    $("preview-pause").textContent = preview.paused ? "继续预览" : "暂停预览";
    $("preview-state").textContent = preview.paused
      ? "预览已暂停，解析仍继续"
      : "跟随消息展示";
  };
  $("preview-clear").onclick = () => preview.clear();
  $("preview-fullscreen").onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("preview-panel").requestFullscreen();
    } catch {
      $("preview-state").textContent = "当前浏览器未允许全屏";
    }
  };
  document.addEventListener("fullscreenchange", () => {
    $("preview-fullscreen").textContent = document.fullscreenElement
      ? "退出全屏"
      : "全屏预览";
  });
  return preview;
}
