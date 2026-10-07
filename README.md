# douyinprotobuf

抖音 WebCast 官方运行时协议解析工程。

完整项目位于 [protobuf-live](protobuf-live/README.md)，包含离线 HAR 流水线、实时工作台、官方 Parser、中文 proto3 快照与正式 `proto.dict` 字典。

支持官方 Parser 定时更新与版本差异日志、弹幕 SSE 实时流，以及外部 rawproto 目录的只读审计/监听。当前官方快照为 2,726 个消息、15,391 个字段；使用方法与验收记录见工程 README。

```powershell
cd protobuf-live
npm ci
npm start
```
