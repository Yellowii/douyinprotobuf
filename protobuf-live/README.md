# 抖音 WebCast 直播协议工作台

基于浏览器加载的官方 Parser JS，提供 HAR 离线批量解析、实时直播间观察，以及同时生成中文 proto3 快照和正式协议字典的 Node.js 工程。解析器实际调用官方解码函数，不依赖 DySpider 或其他项目的静态旧 proto。

当前官方快照包含 **2,726 个消息、15,391 个字段**，已更新至官方 `live-schema-im.e322bd8a.js`。本地 HAR 和 raw 样本仅用于验收，不随仓库发布。

## 启动

需要 Node.js 24 或以上。浏览器模式需要本机 Chrome / Edge；项目不会自动下载浏览器。

```powershell
git clone https://github.com/Yellowii/douyinprotobuf.git
cd douyinprotobuf/protobuf-live
npm ci
Copy-Item .env.example .env
npm start
```

打开 <http://127.0.0.1:8787>。Windows 默认自动查找 Chrome / Edge；其他位置或系统可在 `.env` 中配置 `BROWSER_EXECUTABLE`。

- **直播间 URL 模式**：输入 `https://live.douyin.com/数字房间号`。真实浏览器加载当前官方 SDK，由 SDK 建立连接并管理签名、心跳与 ACK。勾选“显示浏览器窗口”后可人工登录或完成验证；登录完成后点击工作台“保存登录态”，后续启动浏览器自动恢复本地保存的状态。
- **WSS 直连模式**：从当前浏览器请求复制有效的 WSS 地址。Cookie 从 `.env` 的 `DOUYIN_COOKIE` 读取，User-Agent 可配置为 `DOUYIN_USER_AGENT`。Node 负责心跳、ACK 和连接恢复。“新版 ByteLink 回执”用于当前 SDK 的头部回执格式；外层 `service=9999` 也会自动识别为新版。
- **raw_proto 只读监听模式**：输入已有二进制样本目录。开始时忽略历史文件，新写入且完整的 `.bin` 自动调用同一个官方 Parser 解码；兼容 `.bin.meta.json` 和同名 `.json`。不复制、修改或删除输入文件，结果进入本项目日志和实时工作台。
- **rawproto 文件夹批量解析模式**：解析目录中已有的 `.bin`。显示扫描、解析、保存进度和成功/失败/未知统计，可停止并保留部分结果，完成后可下载报告；源目录保持只读。
- 若直播间需要登录，优先使用可见浏览器模式。WSS 地址的签名与游标可能过期，需要重新从当前会话获取；Cookie 并不能替代所有握手参数。

`.env` 与 `.browser-profile/` 都在 Git 忽略范围内。不要把 Cookie 写入源码、README、日志或 Git。Cookie 在每次开始浏览器或 WSS 连接时重新读取，修改后无需重启；端口等其他配置仍需重启。默认 `.env.example` 不含任何真实凭据。

保存登录态的操作：选择直播间 URL 模式，勾选“显示浏览器窗口”，开始观察并在弹出的浏览器完成登录，然后回到工作台点击“保存登录态”。即使尚未建立 WebCast 连接，只要浏览器仍打开也可保存。保存完成后再停止连接。

连接区域新增当前账号监测，显示已登录、访客、待确认、检测失败等状态；官方接口确认账号后显示头像、昵称、抖音号（若提供）和 UID。监测的是**工作台打开的采集浏览器**，与其他浏览器或工作台网页自身的登录状态分别管理。WSS 直连没有官方页面可核验时，不根据 Cookie 存在推断已经登录。

监测优先复用页面自身的当前用户响应，额外查询每分钟至多一次；“检测登录态”额外查询至少间隔 15 秒。保存动作等待冷却后重新查询，只有确认已登录才写入配置，访客或检测失败会保留原配置。保存时可能等待约 15 秒。页面验证或接口响应异常会显示检测失败，不能将其视为已登录；需在可见采集浏览器完成登录或验证后再次检测。收包状态与账号状态分别显示，访客模式也可能收到直播消息。

“保存登录态”将当前适用于直播站点的 Cookie 写入 `.env` 的 `DOUYIN_COOKIE`，保留其他配置；同时将抖音域 Cookie 的有效期、域、路径、HttpOnly 等属性与本地存储保存至 `.browser-profile/login-state.json`。浏览器模式恢复该状态，WSS 直连读取 Cookie。只保存抖音来源，页面和接口只显示配置状态和保存时间，不返回 Cookie 内容。手动修改或清空 `.env` 中的 `DOUYIN_COOKIE` 后，旧浏览器状态不会覆盖新配置；已有连接需停止再开始才能应用更改。会话过期或平台要求验证时，重新登录并保存。

## 基础插件与官方样式集成

工作台“互动预览”支持滚动弹幕、屏幕/特权弹幕样式、礼物托盘、显示开关、暂停/继续、清空、字号、速度、透明度和全屏预览。显示设置保存在当前浏览器；点击弹幕或礼物可查看原始 JSON。暂停或清空只影响展示，连接、解析与完整日志仍继续。

实时消息使用现有 `barrage` 与 `packet` 流；批量模式使用有限的 `batch-preview`，不会将批量预览重复算入实时统计。新连接或新批量任务自动重置展示去重记录，重连使用同一会话标识。礼物支持 `GiftMessage` 和嵌套的 `BindingGiftMessage.msg`；同组 `repeat_count` 按累计数量更新，不相加，默认零值会回退到有效计数，64 位数量保持十进制字符串。

`static/vendor/` 内保留官方下载的 `DanmakuPlugin.bf02df37.css`、`GiftTrayPlugin.ad979c7b.css` 原始内容及 SHA-256/来源记录。它们在 Shadow DOM 内加载，与工作台其他区域隔离；礼物背景使用 CSS 自带的内嵌图片，不向外部请求头像或礼物资源。页面最多保留 40 条滚动弹幕、3 张礼物卡，礼物 8 秒后自动退出，暂停时保留当前展示。

官方业务插件 JS 需要抖音页面的 webpack、播放器、状态仓库与消息环境。当前接入由 `static/plugins.js` 的展示适配器完成，消费本项目已解析的 JSON 并复用官方样式；原始官方下载 JS 作为本地分析素材保留在 `output`。这是消息互动预览，不包含视频播放、送礼支付或付费直播权限逻辑。

## 固定目录与职责

```text
protobuf-live/
├─ src/                  核心源码、官方协议 JS、测试与实施记录
│  └─ vendor/            官方 live-schema / transport-schema 模块及来源摘要
├─ samples/
│  ├─ capture/           HAR 原始抓包，忽略入库
│  ├─ raw_packets/       抽取的二进制及元数据，忽略入库
│  └─ proto_dump/        中文 proto3 人工查阅快照，提交 Git
├─ dist/
│  └─ proto.dict         JSON 格式正式协议字典，提交 Git
├─ output/               结构化日志和验收报告，忽略入库
├─ static/               浏览器工作台与展示适配器
│  └─ vendor/            已接入的原始官方 CSS 与来源摘要
├─ .env.example
├─ .gitignore
├─ package.json
├─ package-lock.json
└─ README.md
```

## HAR 抓包教程

1. 用 Chrome / Edge 打开直播间，打开开发者工具的 Network 面板。
2. 勾选 Preserve log，刷新页面，保持直播间运行一段时间。不要只导出页面初次加载之前的记录。
3. 在 WS 分类找到路径含 `/webcast/im/` 的连接，在 Messages 面板确认存在二进制下行帧。
4. 使用“Save all as HAR with content”导出到 `samples/capture/`。为获取协议模块，需保留 JS 响应内容；协议模块通常名为 `live-schema-im.*.js` 和 `transport-schema-im.*.js`。
5. 检查 HAR 对应 entry 有 `_webSocketMessages` 数组，消息具有 `type: "receive"`、`opcode: 2` 和 base64 `data`。并非所有浏览器版本/导出方式会保存 WebSocket 载荷：若缺少该扩展，HAR 无法补回未记录的帧，需要使用能导出此扩展的抓包工具，或通过本工程浏览器模式/CDP 记录帧。

HAR 可能含请求 Cookie 和个人信息，始终保留在本地。实时模式会把实际下行 bytes 保存为 `samples/raw_packets/live-*.bin`，便于后续离线重放。

## 离线批量解析

```powershell
# 从 HAR JS 响应提取官方协议模块，并同时生成两类产物
npm run import

# 流式读取 samples/capture 中所有 HAR，抽取下行包、解码全部 raw_packets，更新两类产物
npm run offline

# 可指定现有资源目录；路径含空格时用引号
npm run offline -- --capture "D:/captures" --raw "D:/packets"
```

`offline --raw` 是抽取包的**写入工作目录**。审计既有外部目录必须使用下方 `audit:raw`，以保证只读。

筛选条件为 WebSocket entry 下的 `type=receive`、`opcode=2`，严格检查 base64，再保存 `.bin` 与 `.bin.meta.json`。不会将上行 ACK、文本消息或 WebSocket ping opcode 混作业务包。

原始业务 payload 也可直接放入 `raw_packets/`：文件名采用 `时间_WebcastChatMessage_消息ID.bin`，或者写入同名 `.bin.meta.json`：

```json
{"method":"WebcastChatMessage","msg_type":0}
```

如果 bin 是直接传输的 Response 而非 PushFrame，可以使用 `{"format":"response"}`；无元数据时按自动模式尝试外层帧和 Response。业务 payload 不根据试解码结果猜类型，必须提供 method。

输出文件：

| 文件 | 内容 |
|---|---|
| `output/events.jsonl` | 每个成功读取的包、信封和业务消息；每行一个 JSON |
| `output/failures.jsonl` | HAR/base64/传输包/业务载荷错误及来源 |
| `output/unknown.jsonl` | 无对应官方类型的 method 及原始 base64 载荷 |
| `output/report.json` | 包数量、消息类型统计、类型观察与产物覆盖数量 |
| `output/live.events.jsonl` | 实时下行解析日志，追加保存 |
| `output/live.failures.jsonl` | 实时握手、连接和解析异常，追加保存 |

离线任务每次重写离线输出，实时日志持续追加。单个失败包不终止批量任务；单条业务解码失败不影响同批其他消息。64 位整数全部输出十进制字符串，bytes 输出 base64。

## Parser JS 替换方式

本工程同时支持官方编译模块和完整反射 Root：

1. **现有官方 Web 模块**：把当前 `live-schema*.js` 与 `transport-schema*.js` 放到 `src/vendor/`。每个系列保留一个有效版本。也可以执行 `npm run import` 从 HAR 导入；按抓包时间选择每个系列最新资源，清理同系列旧哈希文件，记录文件摘要与来源。只执行协议模块，依赖缺失会明确失败，不尝试执行整个网站业务入口。
2. **浏览器内存 descriptor 导出**：将完整 Root/descriptor 通过自包含 CommonJS `official-parser.js` 导出。支持 `module.exports = root`、`module.exports = { root }` 或 descriptor JSON 对象。文件可 `require("protobufjs")`，不支持任意 Node 依赖。使用一个只有该文件的目录，并在 `.env` 设置 `PARSER_DIR` 指向该目录，避免与旧模块混用。

反射导出应当是**浏览器官方运行时 descriptor**，不是人工编写或第三方静态 proto。运行时 Root 的 `toJSON()` 是可用的结构导出途径。不要只导出几个 decode 函数而丢掉 descriptor。

当前抓包模块把字段表编译在 decode 函数内部：加载器在受限上下文中执行官方模块，捕获运行时编号、字段名、读取器、repeated/packed 标记，再从独立 map 解码分支恢复键值类型。类型引用按实际函数映射，oneof 从官方 getter 定义恢复。所有原型字段都必须有结构证据；发现未识别字段会停止字典生成，避免静默漏字段。

`src/vendor/provenance.json` 记录官方资源 URL、捕获时间和 SHA-256。`vendor` 内官方脚本保持原始内容，权利归原提供者；不要将它们误认为本工程原创源码。

## 官方 Parser 定时更新与差异日志

```powershell
# 主动检查当前官方网页版本，校验后更新 Parser 和两类协议产物
npm run update-parser
```

工作台运行时默认每 **24 小时**检查一次；首次启动会安排下一次检查，页面“检查更新”可立即触发。服务停止时不运行调度。重启会恢复上次检查时间；手动和自动检查至少间隔 **5 分钟**，同一更新器不重叠请求。`.env` 可配置：

```dotenv
PARSER_AUTO_UPDATE=true
PARSER_UPDATE_INTERVAL_HOURS=24
PARSER_UPDATE_PAGE=https://live.douyin.com
PARSER_UPDATE_URLS=
```

设置 `PARSER_AUTO_UPDATE=false` 关闭定时检查。间隔至少 1 小时。更新器用真实 Chrome/Edge 打开官方首页，从页面当前 webpack runtime 计算 `live-schema-im` 与 `transport-schema-im` 的哈希地址；不会把固定旧地址重新下载误称为发现新版本。也可在 `PARSER_UPDATE_URLS` 显式指定两个当前官方 CDN 地址，以逗号分隔；只接受官方协议 CDN 与模块路径。

候选在 `output/parser-versions/版本ID/` 隔离执行和验证，消息、字段、map/repeated/packed、oneof、enum 差异自动记录。校验通过才替换官方文件和双产物；异常恢复旧文件并保留当前解码器。工作台更新后，已有直播连接后续包使用新版 Parser，无需重新握手；更新前还会重放最近真实帧，防止已能解码的消息退化。未知依赖或官方页面结构改变时，失败明确写入日志。

| 文件 | 内容 |
|---|---|
| `output/parser-updates.jsonl` | 检查时间、状态、旧版/新版 SHA-256、完整结构差异、失败原因 |
| `output/parser-update-state.json` | 上次检查时间，重启后继续限频 |
| `output/parser-versions/版本ID/diff.md` | 中文汇总及消息/字段/枚举变化明细 |
| `output/parser-versions/版本ID/previous/` | 更新前官方模块和成品备份；调试与恢复材料 |

本次实际更新新增 40 个消息结构，既有消息新增 87 个字段、移除 1 个字段，修改 3 个 oneof；新增消息自身字段也完整进入双产物。总字段数从 15,131 增至 15,391。新增的 `BattleStatusMessage` 和 `RoomIMRBControlMessage` 已通过外部真实样本验证。

## 外部 rawproto 只读核验与实时弹幕

在工作台“连接方式”选择 **rawproto 文件夹 · 批量解析已有文件**，填写本机目录（默认读取 `.env` 的 `RAW_PROTO_DIR`），点击“开始解析”。该模式处理启动时目录第一层已有的 `.bin`，不递归扫描子目录；新文件实时解析请选择 **raw_proto 只读监听**。

每次批量任务单独保存至 `output/raw-batches/任务ID/`：`raw-audit.events.jsonl` 保存完整包和消息 JSON，另有 `raw-audit.report.json`、`raw-audit.failures.jsonl`、`raw-audit.unknown.jsonl`、`raw-audit.barrage.jsonl`。页面按间隔展示有限预览，完整结果以文件为准，避免大目录压垮前端；同一服务运行期间刷新页面可恢复进度或最近报告。停止会结束后续读取、保存已完成部分。任务结束同时更新中文 `.proto` 和正式 `proto.dict`。

下面两个命令也可独立使用：

```powershell
# 全量核验，只读取源目录，默认输出本项目 output/external-audit
npm run audit:raw -- --raw "D:/Proj/LiveDash/WssBarrageServer/raw_proto"

# 命令行持续解析新文件；历史文件使用上面的审计命令处理
npm run watch:raw -- --raw "D:/Proj/LiveDash/WssBarrageServer/raw_proto"
```

可设置 `.env` 的 `RAW_PROTO_DIR` 作为默认输入。同名 JSON 支持 UTF-8 BOM；消息 ID 优先使用文件名的十进制串，元数据的 `msg_id`/`offset` 也按原始数字字面量保留，避免 JavaScript 大整数舍入。监听先等待文件稳定，截断包会重试；文件通知另有每分钟只读扫描补漏。所有文件只以 `r` 打开，审计拒绝将结果目录设在输入目录内部。

审计产物为 `raw-audit.report.json`、`raw-audit.failures.jsonl`、`raw-audit.unknown.jsonl`、`raw-audit.barrage.jsonl`。机器字典中的类型观察会吸收本次实际信封数值。全量核验：**344,354 包、71 种 method；344,275 成功解析、0 解码失败、79 未知**。其中 78 个 `WebcastRoomNotifyMessage`、1 个 `WebcastRoomHighlightAreaHotCommentMessage` 在当前官方模块中没有定义，保留原始 base64，不伪造协议结构。

工作台“实时弹幕”单独显示文字、表情、屏幕和语音弹幕，完整消息仍可查看。程序可订阅：

```javascript
const stream = new EventSource('http://127.0.0.1:8787/api/barrage/events');
stream.addEventListener('barrage', event => {
  const { message_id, user, text, kind, data } = JSON.parse(event.data);
  console.log(message_id, user.nickname, text, kind); // data 保留完整官方解析结构
});
```

该地址用于同一主机同源工作台，沿用 Host/Origin 校验。`/events` 同时推送完整 `packet`、标准化 `barrage` 和 `parser-update` 事件；跨源浏览器页面需自行通过同源代理接入。弹幕 ID 与用户 ID 为十进制字符串，表情/语音附加信息有独立字段。

## 两类协议产物

```powershell
npm run dict
npm run verify
```

`dict` 每次**同时**生成并验证两个文件；`offline` 解析后和 `start` 启动时也会生成两个文件。停止实时观察时，新的消息类型数值观察会同步到字典。生成前验证所有消息和字段结构，临时文件写入完成后替换产物。

| 产物 | 用途 | 是否交付/提交 |
|---|---|---|
| `samples/proto_dump/live_debug_snapshot.proto` | 人工逆向查阅、对比与调试；标准 proto3，消息/字段/枚举/枚举值均带中文注释 | 是，调试快照 |
| `dist/proto.dict` | JSON 格式机器读取的正式协议字典；字段和消息全名稳定 | 是，正式成品 |

快照用容器消息表示 JS 命名空间，因此 `.webcast.im.ChatMessage` 等全名得到保留。容器明确标为“非线上业务消息”；没有删除多层嵌套或把不同命名空间的同名类型混在一起。它可以由 protobufjs/protoc 加载。

字典每个消息项包含要求的 `msg_type_id`、`desc`、`fields`、`enums`。字段包含 `field_name`、`field_number`、`proto_type`、`is_repeated`、`is_nested`、`comment`；map 另有 `is_map`/`map_key_type`，互斥字段另有 `oneof`。

`enums` 中使用完整 `枚举全名.枚举项` 作为数值键，另有整体中文 `comment`。`enum_comments` 和 `enum_value_comments` 分别保存每个枚举及枚举值的中文说明。同命名空间枚举归档到该命名空间第一个消息项，避免遗漏独立于 message 的枚举。

### 必须理解的证据边界

- **全量指当前官方 Parser 提供的所有定义**，不代表服务端所有版本、直播伴侣所有特有协议均已提供。例如本地样本中的 `WebcastRoomNotifyMessage` 没有对应官方 Web 类型，故保留原载荷并记录未知；不会伪造结构来宣称覆盖。
- 当前官方模块只有一个可枚举的 enum 定义，部分枚举字段被编译为普通 `int32`，关联元信息已经丢失；不猜测它们应该引用哪个枚举。使用完整反射导出时会保留确切 enum 类型。
- `Message.msg_type` 是信封属性，真实样本多个不同消息共享 `0`。它不是可自行推导的全局唯一类型 ID。没有证据的消息 `msg_type_id=0` 并注明未知；观察到的真实值保存在 `observed_msg_type_ids` 与 `msg_type_id_source`。不会按数组下标编造 ID。
- 每个字段都有中文注释；结构信息来自官方定义。尚未确认的业务语义显式标为“名称推断/待样本确认”。可在 `src/comment-overrides.json` 按实际消息全名/字段名补充业务说明，在 `src/comments.js` 更新术语后重新生成。项目吸收了本地补充的常见字段说明，并修正了“msg_type 与 method 一一对应”“visible_to_sender 必定仅发送者可见”等没有证据支持的表述；不会依据注释库增添不存在的字段。
- 若 proto3 要求的 enum 零值缺失，会补充带 `SNAPSHOT_UNSPECIFIED` 的零值，并注明它是快照兼容项。现有快照不需要该补充。
- `PayloadInIm` 结构已归档，可按该类型直接解码；当前抓包 SDK 没有可确认的自动切换规则，所以不会凭空假定 ByteLink 版本头或挑选一个 map 载荷作为 Response。

## 限流与运行保护

默认仅单直播间；直播间网络连接操作至少间隔 30 秒。本地文件批量解析和监听不发送直播间网络请求，不占用该冷却。直连最多尝试 5 次，重连按 30 秒开始指数退避，最长 5 分钟并添加随机间隔；401/403/429 和策略关闭触发熔断，不继续重试。心跳默认 15 秒，90 秒没有下行则关闭连接进入受控恢复。浏览器模式由当前官方 SDK 管理心跳/ACK/重连，本工程不定时刷新页面。

原始包上限 8 MiB、解压上限 32 MiB、单业务 payload 上限 8 MiB；超大业务载荷隔离且错误日志仅保留有限预览。解码及日志队列上限 100，达到上限停止连接，防止无限堆积；慢前端 SSE 客户端自动断开，页面只保留最近 200 条消息。

这些措施减少重复请求与资源占用，**不能保证规避平台风控**。若出现登录验证、限流或签名失效，停止连接并按当前官方会话重新验证。

工作台只监听 `127.0.0.1`，有 Host/Origin 校验和写操作令牌；前端使用文本渲染展示消息。不要直接暴露到公网。

## 测试、提交与更新

```powershell
npm test
npm run verify
npm audit --omit=dev --registry=https://registry.npmjs.org

# 在仓库根目录操作；成品字典和调试快照均应出现在提交中
cd ..
git add protobuf-live README.md .gitignore
git diff --cached --stat
git commit -m "feat: add official WebCast protocol workbench and annotated dictionary"
git push origin main
```

提交前确认没有 `.env`、HAR、raw bin、输出日志或 node_modules。仓库已保留空样本目录；重新克隆后无需私有 HAR 就能使用附带官方快照启动工作台和生成双产物。

验收记录见 [src/VALIDATION.md](src/VALIDATION.md)，官方更新与 344,354 个外部包的只读核验见 [src/UPDATE_VALIDATION.md](src/UPDATE_VALIDATION.md)，前端批量模式见 [src/BATCH_VALIDATION.md](src/BATCH_VALIDATION.md)，展示插件见 [src/PLUGIN_VALIDATION.md](src/PLUGIN_VALIDATION.md)，登录保存与恢复见 [src/LOGIN_VALIDATION.md](src/LOGIN_VALIDATION.md)，账号监测见 [src/ACCOUNT_VALIDATION.md](src/ACCOUNT_VALIDATION.md)。当前 40 项测试、标准 proto3 验证和格式检查通过。前端及登录态浏览器测试需要本机 Chrome/Edge；未安装时明确跳过相关浏览器测试，后端测试仍运行。当前 Node 直连在本地 WebSocket 服务上验证了收包、ACK 与停止；真实抖音房间使用可见官方浏览器验证。真实服务器的所有直连握手组合尚未穷举。

## 参考与文档

- [Yellowii/DySpider](https://github.com/Yellowii/DySpider)：借鉴抓包查找、PushFrame → 解压 → Response → method 分派的分析流程。未复制其静态 proto 或业务源码。
- [protobuf.js 官方项目](https://github.com/protobufjs/protobuf.js)：运行时反射与协议结构校验。
- [ws 官方项目](https://github.com/websockets/ws)：Node WebSocket 客户端。
- [stream-json 官方项目](https://github.com/uhop/stream-json)：大型 HAR 流式读取。
- [Playwright 官方文档](https://playwright.dev/docs/api/class-websocket)：浏览器原始帧观察。
- [Playwright 页面 API](https://playwright.dev/docs/api/class-page)：官方页面运行时资源发现。
- [Node 文件系统文档](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)：目录通知与只读文件输入。
