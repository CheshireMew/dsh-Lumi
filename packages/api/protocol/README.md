# @deepseek-ai/dsh-api-protocol

English | [中文](README.zh.md)

Browser-safe declarations and carrier adapters for the legacy application API. The package owns RPC messages, domain schemas, `ApiProxy`, the payload-direct client, and the pure `Request`/`Response` host adapter. It does not implement product behavior or register routes.

Both `client/connection` and `host/apiproxy` depend on this package. Keeping the shared protocol below both sides prevents the transport layer from importing the host implementation.

## Model Experience

None, as the package serializes client and Host messages but does not assemble a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The protocol remains a monolithic legacy API while domains migrate to Typert Remotes. New remotely exposed capabilities should use the Typert protocol and registry instead of extending this surface.
