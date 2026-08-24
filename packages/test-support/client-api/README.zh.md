# @deepseek-ai/dsh-client-api-testkit

[English](README.md) | 中文

供 Client 包共用的可编程 `IApiClient` 测试替身。测试可以替换一元调用处理器、检查按时间排序的调用记录，并控制两条事件流，无须复制整套协议实现。

## 模型体验

无，因为本包属于测试基础设施，不会挂载到产品组合中。

#### KV Cache 影响

无。

## 已知限制与后续工作

- 本测试工具仍跟随旧 API 协议；各领域迁移到 Typert Remotes 后，它会相应缩小。
