// 仅按官方事件类型归类弹幕；不把点赞、礼物通知误当成用户发言。
const chatMethods = new Map([
  ["WebcastChatMessage", "text"],
  ["WebcastEmojiChatMessage", "emoji"],
  ["WebcastScreenChatMessage", "screen"],
  ["WebcastPrivilegeScreenChatMessage", "privilege"],
  ["WebcastAudioChatMessage", "audio"],
  ["WebcastExhibitionChatMessage", "exhibition"],
]);
export function toBarrage(message, receivedAt = new Date().toISOString()) {
  const kind = chatMethods.get(message.method);
  if (!kind || message.status !== "decoded") return null;
  const d = message.data || {},
    user = d.user || d.sender || {};
  return {
    kind,
    method: message.method,
    type: message.type,
    message_id: String(message.msg_id ?? d.common?.msg_id ?? ""),
    received_at: receivedAt,
    user: {
      id: String(user.id ?? user.id_str ?? ""),
      nickname: user.nickname || user.nick_name || "",
      sec_uid: user.sec_uid || "",
    },
    text:
      d.content ||
      d.text ||
      d.chat_text ||
      d.default_content ||
      d.emoji_content?.default_pattern ||
      d.display_text?.default_pattern ||
      "",
    emoji: d.emoji_content || d.emoji || null,
    audio:
      d.audio_content ||
      d.audio ||
      (d.audio_url ? { url: d.audio_url, duration: d.audio_duration } : null),
    data: d,
  };
}
