# Parser 更新与外部原始包核验

日期：2026-10-07（Asia/Shanghai）。

## 官方更新证据

- 通过官方 https://live.douyin.com 页面实际 webpack runtime 发现新哈希，不使用旧 URL 推断当前版本。
- 旧版 live-schema-im.aa08852d.js：SHA-256 `082a0b5238cfed829d0e38187d3ab0bb499be229b6f87bd95a29734e48a9ac19`。
- 新版 live-schema-im.e322bd8a.js：SHA-256 `232a3d3890052ebe868b4b14aca38918730285adbc0f623c77dc8bdaafbc783b`。
- transport-schema-im.63ff9a29.js 未变化：SHA-256 `11240991fcc7b733ca2349442c0e9523d4a40f978a8c432fa3993f9e2a51d750`。
- 消息 2,686 → 2,726；字段 15,131 → 15,391；消息新增 40、删除 0；既有消息字段新增 87、删除 1、修改 0；oneof 修改 3。新增消息字段包含在总字段数中。
- 新增 BattleStatusMessage、RoomIMRBControlMessage 已按官方 descriptor 归档，补充中文语义说明；不推断缺失枚举的具体取值。
- 更新前备份和完整差异保存在本地 output/parser-versions，更新检查日志为 output/parser-updates.jsonl，均不提交私有运行材料。

## 外部目录只读核验

输入：用户指定的 D:\Proj\LiveDash\WssBarrageServer\raw_proto。

| 指标 | 数量 |
|---|---:|
| 二进制包 | 344,354 |
| method | 71 |
| 官方结构可解码 | 344,275 |
| 解码失败 | 0 |
| 缺少官方结构 | 79 |

原版可识别 67 种事件；新版本可识别 69 种。BattleStatus 1 包、RoomIMRBControl 11 包由此次官方更新补齐。RoomNotify 78 包、RoomHighlightAreaHotComment 1 包仍缺官方 Web 定义，保留原始载荷到未知日志，不添加人工 proto。

读取使用 r 模式，不向输入写入任何文件。样本自带的同名 JSON 与 .bin.meta.json 均支持，64 位 msg_id 不经 Number 转换。结果在工程 output/external-audit 中；完整包的 SHA-256 汇总保存在报告中，原始样本、业务日志与个人信息均不提交。

## 验证范围

新增测试涵盖字段编号旧/新差异、刷新缓存、合法更新与非法候选保留旧版、重启后检查限频、同名 JSON/BOM/uint64、只读审计、新文件实时监听及截断后补全重试。

最终 **26 项测试全部通过**。新增独立弹幕 SSE 验证包含消息 uint64 最大值、用户 int64 最大值的十进制精度；定时器通过受控时间推进验证到期实际检查，版本未变也生成双产物。激活失败能恢复官方文件、proto 与字典，共享产物锁在写入前等待其他保存任务。

标准 proto3 已由本地 protoc 36.2 编译；protobufjs 重新载入后核对 2,726 消息、15,391 字段。格式检查通过。真实 Chrome 前端接收 3 条测试弹幕，脚本异常 0；390 像素窄屏无页面水平溢出。截图在被忽略的 output 中。

独立审查指出并修复：文件重复通知造成弹幕重复；未知裸依赖不应被静默忽略；自动更新与停止保存的产物竞态；输出 junction/symlink 指向输入时必须在 mkdir 前拒绝。各问题均补充回归测试。新官方辅助模块 196405 在页面运行时核验为未使用的对象展开/异步辅助导出，白名单不泛化到未知依赖。

实时弹幕沿用已验收的官方浏览器与 Node WSS 下行链路，新增独立 SSE 弹幕流及原始目录流。当前官方页面资源发现已真实联网验收；定时调度使用配置间隔和持久化时间。实时文件流通过本地持续写入与接口检查验证；没有向用户外部样本目录注入测试文件。
