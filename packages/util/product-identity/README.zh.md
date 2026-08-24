# dsh-product-identity

[English](README.md) | 中文

本包是 DeepSeek Harness 公开产品名、发布包族版本、仓库地址、协议产品标识和 HTTP `User-Agent` 的唯一来源。它读取自身已检入的包清单，因此发布版本更新后不需要手工同步源码常量。

## API

协议版本字段使用 `PRODUCT_VERSION`，产品名/版本标识使用 `PRODUCT_TOKEN`，标准 HTTP 标识使用 `PRODUCT_USER_AGENT`；白标身份使用 `productUserAgent(identity)` 显式生成。

## 模型体验

模型通过各能力发出的协议握手和 HTTP 请求间接使用本包。

#### KV Cache 影响

无。

## 已知限制与后续工作

- DeepSeek Harness 的全部包属于同一发布族，因此这里报告共享包族版本，而不是单独为某个部署外壳维护版本。
