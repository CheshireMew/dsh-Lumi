# @dsh-lumi/bundle-desktop

English | [中文](README.zh.md)

The additive product layer applied after the official `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` bundles. Its patch inserts the Lumi profile plugin, `@dsh-lumi/client-character`, and `@dsh-lumi/client-shell`, which keeps the complete product roster difference reviewable during upstream synchronization. The profile plugin registers authenticated model discovery for `llm-deepseek`: the Models UI can test an unsaved API key against the configured endpoint's `/models` route before the credential store is changed.

## Model Experience

None, as the bundle adds presentation, browser speech, local character settings, local bond progress, and settings-time credential verification without adding system-prompt sections, tools, session events, or model-visible content.

#### KV Cache effect

None; the bundle does not change model requests.

## Known Limitations and Deferred Work

- The bundle requires both official bundles to be applied before it; it is not a standalone Harness profile.
- Character behavior is browser-local and therefore unavailable to headless and ACP surfaces.
