# 抖音 WebCast 直播协议工作台

基于浏览器加载的官方 Parser JS，提供 HAR 离线批量解析、实时直播间观察，以及同时生成中文 proto3 快照和正式协议字典的 Node.js 工程。解析器实际调用官方解码函数，不依赖 DySpider 或其他项目的静态旧 proto。

当前官方快照包含 **2,686 个消息、15,131 个字段、303 个 map、48 组 oneof、147 个 packed repeated 字段**。本地 HAR 和 raw 样本仅用于验收，不随仓库发布。

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

- **直播间 URL 模式**：输入 `https://live.douyin.com/数字房间号`。真实浏览器加载当前官方 SDK，由 SDK 建立连接并管理签名、心跳与 ACK。勾选“显示浏览器窗口”后可人工登录或完成验证。浏览器使用临时会话，不导出登录 Cookie。
- **WSS 直连模式**：从当前浏览器请求复制有效的 WSS 地址。Cookie 从 `.env` 的 `DOUYIN_COOKIE` 读取，User-Agent 可配置为 `DOUYIN_USER_AGENT`。Node 负责心跳、ACK 和连接恢复。“新版 ByteLink 回执”用于当前 SDK 的头部回执格式；外层 `service=9999` 也会自动识别为新版。
- 若直播间需要登录，优先使用可见浏览器模式。WSS 地址的签名与游标可能过期，需要重新从当前会话获取；Cookie 并不能替代所有握手参数。

`.env` 在 Git 忽略范围内。不要把 Cookie 写入源码、README、日志或 Git。修改 `.env` 后重启服务。默认 `.env.example` 不含任何真实凭据。

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
├─ static/               浏览器工作台
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

默认仅单直播间；连接操作至少间隔 30 秒。直连最多尝试 5 次，重连按 30 秒开始指数退避，最长 5 分钟并添加随机间隔；401/403/429 和策略关闭触发熔断，不继续重试。心跳默认 15 秒，90 秒没有下行则关闭连接进入受控恢复。浏览器模式由当前官方 SDK 管理心跳/ACK/重连，本工程不定时刷新页面。

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

验收记录见 [src/VALIDATION.md](src/VALIDATION.md)。当前 Node 直连在本地 WebSocket 服务上验证了收包、ACK 与停止；真实抖音房间使用可见官方浏览器验证。真实服务器的所有直连握手组合尚未穷举。

## 参考与文档

- [Yellowii/DySpider](https://github.com/Yellowii/DySpider)：借鉴抓包查找、PushFrame → 解压 → Response → method 分派的分析流程。未复制其静态 proto 或业务源码。
- [protobuf.js 官方项目](https://github.com/protobufjs/protobuf.js)：运行时反射与协议结构校验。
- [ws 官方项目](https://github.com/websockets/ws)：Node WebSocket 客户端。
- [stream-json 官方项目](https://github.com/uhop/stream-json)：大型 HAR 流式读取。
- [Playwright 官方文档](https://playwright.dev/docs/api/class-websocket)：浏览器原始帧观察。
