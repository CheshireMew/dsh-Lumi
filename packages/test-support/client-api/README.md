# @deepseek-ai/dsh-client-api-testkit

English | [中文](README.zh.md)

Shared programmable `IApiClient` test double for Client packages. Tests can replace unary handlers, inspect chronological calls, and control both event streams without copying a full protocol implementation.

## Model Experience

None, as this package is test infrastructure and is not mounted in a product composition.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The testkit follows the legacy API protocol and will shrink as domains migrate to Typert Remotes.
