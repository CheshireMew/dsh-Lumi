# dsh-product-identity

English | [中文](README.zh.md)

This package is the single source of the public DeepSeek Harness product name, published package-family version, repository URL, protocol product token, and HTTP `User-Agent`. It reads its checked-in package manifest, so release versioning updates identity without hand-copied source constants.

## API

Use `PRODUCT_VERSION` for protocol version fields, `PRODUCT_TOKEN` for product/version identifiers, `PRODUCT_USER_AGENT` for standard HTTP attribution, and `productUserAgent(identity)` for an explicitly supplied white-label identity.

## Model Experience

Indirectly, through protocol handshakes and HTTP requests made by capabilities the model uses.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- All DeepSeek Harness packages are one release family; this identity therefore reports the shared package-family version rather than a separately versioned deployment shell.
