# @dsh-anime/client-character

English | [中文](README.zh.md)

Character domain for the Electron anime shell. Its Host half registers the `ui-anime` settings namespace and serves Character Pack v1 assets from `$DSH_HOME/anime/packs`. Its browser half owns observable character state, system speech, unbounded bond progress and deduplication ledgers, live pack refresh, the General settings row, and per-assistant-message read, pause, resume, and stop controls.

Pack manifests declare a canvas, fixed preview and background, body and mouth layers, expression and effect maps, all eight states with animations and fallbacks, idle actions, and bilingual bond unlocks. Invalid manifests, duplicate ids, path traversal, missing assets, and unsupported image formats fail closed; the original layered Lumi assets remain available as the fallback. A missing license keeps a valid pack local-only.

## Model Experience

None, as character state only observes the existing browser projection, message feedback changes, and settings; speech sanitization and bond progress never enter the append-only Session log or model context.

#### KV Cache effect

None; no character operation changes the model history.

## Known Limitations and Deferred Work

- Speech uses the browser's installed speech-synthesis voices, so voice availability and pronunciation vary by Windows installation.
- Pack validation covers metadata and file containment but does not verify the legal accuracy of a pack author's license declaration.
- The built-in Lumi image is an original vector placeholder intended to be replaced by a final art pack without changing runtime code.
