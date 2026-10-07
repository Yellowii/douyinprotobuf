# 抖音 WebCast 工程实施记录

目标：基于本地官方 JS 运行时 descriptor，交付 Node.js 解析工程、中文 proto3 快照、程序字典及实时工作台。

## 设计

- 唯一协议源为 HAR 内官方 JS 或用户替换的 JS；不引入静态旧 proto。
- 使用受限 webpack 模块加载器执行协议模块；将完整运行时 descriptor 归一化为 protobufjs Root，保留来源和原始结构证据。
- 遍历所有 namespace、message、嵌套 message、enum、oneof、map；中文注释覆盖所有声明，未确认业务语义明确标记推断。
- 字典中 msg_type_id 只来自 descriptor 或实际封装 Message.msgType；无已知 ID 时使用 0 并写明未知，禁止编造唯一编号。
- 多包名 proto3 快照使用命名空间容器消息和绝对类型引用保持全名；验证重新加载及字段结构一致。
- 离线以流式 HAR entries 处理，筛选 receive/opcode=2，失败包隔离，未知方法保留原字节。
- 实时支持用户提供新鲜 WSS 和 Cookie，以及浏览器采集握手模式；不复用过期签名。单房间、串行解码、退避、鉴权熔断、心跳/ACK、队列上限。
- 前端只监听本机，使用 SSE；Cookie 只保留内存或被忽略的环境文件，不写入日志或 Git。

## 执行计划

1. [x] 协议加载：提取官方 bundle，定位 descriptor 模块；测试加载失败、嵌套/枚举/map 遍历。
2. [x] 双产物：生成中文注释与来源说明；测试 proto3 可重新加载及字典字段一致、稳定输出。
3. [x] 离线解析：HAR 流式提取、PushFrame 解压、Response 和业务 payload 分层解码、原始业务 bin 支持；测试错误隔离、64 位整数、未知方法。
4. [x] 实时与工作台：受控连接、心跳 ACK、串行日志、SSE 和可视化；本地 WebSocket 服务验证协议控制帧、停止和重连。
5. [ ] 交付：README、忽略敏感样本但提交双产物、依赖锁、完整真实样本跑测、GitHub 同步。

## 结果与决策

- 官方模块恢复 2,686 消息/15,131 字段/303 map/48 oneof；原生 protoc 编译成功。
- 新增完整反射 Root 导出支持，保证未来保留 enum 类型关联。
- 业务语义只能推断时保留“名称推断/待样本确认”；未知消息不编造结构，0 类型 ID 不伪装成全局唯一编号。
- SDK 没有自动 ByteLink wrapper 版本切换证据，移除猜测路径，保留 PayloadInIm 的结构解码能力。
- 实施直接在用户指定空工程目录进行；独立只读审查由 requesting-code-review 技能要求派发一次，未派发实现任务。
- 全部验证细节与已知限制保存在 VALIDATION.md。

## 重点验证

空/畸形 HAR、不同压缩形式、未知消息、descriptor 全名冲突、鉴权失败/关闭后定时器、工作台跨源请求与敏感日志。

执行方式：当前会话直接实施；用户已提供完整需求并授权源码同步。遵守固定目录，计划保存在 src 内。
