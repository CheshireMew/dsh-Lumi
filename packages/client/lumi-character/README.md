# @dsh-lumi/client-character

English | [中文](README.zh.md)

Character domain for the Electron Lumi shell. Its Host half registers the `ui-lumi` settings namespace and serves Character Pack v1 assets from `$DSH_HOME/lumi/packs`. Its browser half composes independently owned pack transport validation, speech playback, bounded bond ledgers, live pack refresh, observable character state, the General settings row, and per-assistant-message read, pause, resume, and stop controls.

The package root tsconfig is a solution over explicit Host and Client leaves. Host compilation owns local pack discovery, settings registration, routes, and the invariant companion; Client compilation owns browser state, speech, and components. Bond, manifest, built-in pack, and settings modules are identical shared inputs to both leaves; browser consumers import pack types through the dedicated `@dsh-lumi/client-character/contract` subpath. Direct Project References must name the matching leaf so the Host build never reaches Client Remote declarations before Typert generates them.

Pack manifests declare a canvas, fixed preview and background, body and mouth layers, expression and effect maps, all eight states with animations and fallbacks, idle actions, and bilingual bond unlocks. Invalid manifests, duplicate ids, path traversal, missing assets, and unsupported image formats fail closed; the original layered Lumi assets remain available as the fallback. A missing license keeps a valid pack local-only.

## Model Experience

None, as character state only observes the existing browser projection, message feedback changes, and settings; speech sanitization and bond progress never enter the append-only Session log or model context.

#### KV Cache effect

None; no character operation changes the model history.

## Known Limitations and Deferred Work

- Speech uses the browser's installed speech-synthesis voices, so voice availability and pronunciation vary by Windows installation.
- Pack validation covers metadata and file containment but does not verify the legal accuracy of a pack author's license declaration.
- The built-in Lumi layers are the original default character. Third-party packs can replace the presentation without changing runtime code.
