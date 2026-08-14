# @dsh-anime/bundle-desktop

English | [中文](README.zh.md)

The additive product layer applied after the official `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` bundles. Its patch inserts only `@dsh-anime/client-character` and `@dsh-anime/client-shell`, which keeps the complete product roster difference reviewable during upstream synchronization.

## Model Experience

None, as the bundle adds presentation, browser speech, local character settings, and local bond progress without adding system-prompt sections, tools, session events, or model-visible content.

#### KV Cache effect

None; the bundle does not change model requests.

## Known Limitations and Deferred Work

- The bundle requires both official bundles to be applied before it; it is not a standalone Harness profile.
- Character behavior is browser-local and therefore unavailable to headless and ACP surfaces.
