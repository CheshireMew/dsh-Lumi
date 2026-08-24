# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

JSON backend for the [storage hub](../storage/README.md): one human-readable `<unit>.json` file per unit under a configured root, registered as backend `json`. Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Model

- The in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state — legibility is this backend's reason to exist; scale is the SQLite backend's job.
- A missing file opens as an empty unit and materializes on the first write. A foreign or unparsable file rejects with `malformed-medium`; a stored version differing from the descriptor rejects with `version-mismatch` (no migration, pre-release stance).
- Write ordering across calls belongs to the caller (the domain layer's write chain); each single call is atomic and durable once resolved.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; resolved to an absolute path when the backend is constructed and created `0o700` on demand |

The `destroy` primitive removes exactly the closed unit's JSON file and treats an absent file as success. It refuses an open or opening unit; domain recovery policy remains above the backend.

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- No backend-level cross-process write locking: two direct embedders writing the same root can interleave whole-file replacements (last write wins). The shipped `dsh` profile launcher prevents a second Host from using the same canonical `$DSH_HOME`; direct embeddings and bespoke storage roots must arrange one writer themselves.
