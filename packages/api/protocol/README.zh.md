# @deepseek-ai/dsh-api-protocol

[English](README.md) | 中文

旧应用 API 的浏览器安全声明与载体适配包。该包负责 RPC 消息、领域 schema、`ApiProxy`、直接接收业务参数的客户端，以及纯 `Request`/`Response` 宿主适配器；它不实现产品行为，也不注册路由。

`client/connection` 与 `host/apiproxy` 都依赖本包。共享协议位于通信两端的下层，因此传输层不再反向依赖宿主实现。

## 模型体验

无，因为本包只序列化客户端与 Host 消息，不组装模型请求。

#### KV Cache 影响

无。

## 已知限制与后续工作

- 各领域迁移到 Typert Remotes 之前，本协议仍是一个整体式旧 API。新的远程能力应使用 Typert 协议和注册表，不再扩展此处。
