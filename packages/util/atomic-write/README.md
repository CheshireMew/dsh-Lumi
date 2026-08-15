# dsh-atomic-write

English | [中文](README.zh.md)

Zero-dependency atomic file replacement shared by file-backed stores that must never leave partial, symlink-hijacked, or wider-than-intended content on disk — the user-settings document (`dsh-settings-file`) and the credentials store (`dsh-credentials-local`).

## Surface

```ts
import { withFileLock, writeFileAtomic, writeFileAtomicSync } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
declare const render: (previous: string) => string

await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })
writeFileAtomicSync('/home/u/.dsh/window.json', text, { mode: 0o600 })

// Read-modify-write against the same file from several processes.
await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(text), { mode: 0o600 })
})
```

`writeFileAtomic` commits one already-rendered string. The contract, in the order failures would exploit it:

- **Exclusive-create temp** (`wx`, random suffix): the open refuses to follow a symlink planted at a guessable temp path.
- **The fresh inode carries `mode` through the rename**: replacing a wider-permission file narrows it without a chmod race. `mode` is required so the permission decision stays visible at every call site (subject to the process umask, like every fresh inode).
- **`rename` replaces a symlinked target itself**, never writing through to its referent.
- **Same-directory sibling** keeps the rename on one filesystem, so the swap stays atomic.
- **Durability flushes distinguish outcomes**: the temp file is flushed before rename, the committed file is flushed again, and the parent directory is flushed where the operating system supports directory `fsync`. Windows rejects directory `fsync`, so the implementation uses both writable-file flushes and NTFS's journaled rename instead of pretending that a directory flush succeeded.
- Parent directories are created. A failure before rename removes the temp and preserves the old target; a failure after rename raises `AtomicWriteDurabilityError` with `committed: true`, requiring the caller to re-read rather than assuming the old content survived. Readers observe either the old or the new complete content.

`writeFileAtomicSync` applies the same protocol to lifecycle handlers that must finish before process exit. It exists for small, complete documents such as Electron window placement; request-serving stores use the asynchronous form.

`withFileLock` serializes the writers of one file across processes, for the read-render-commit cycles a bare atomic commit cannot make safe on its own. The lock is a `wx`-created `<filename>.lock` sibling, so readers never contend; waiters back off exponentially and fail with a timeout rather than block forever. A contender never removes the existing lock: age cannot distinguish a crashed owner from a paused live writer.

## Model Experience

None, as this is a pure filesystem primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **String content only** — no `Buffer` or stream form until a consumer needs one.
- **Orphaned locks require operator recovery** — a process that exits while holding the lock can leave the sibling behind. Later writers time out without deleting it; an operator removes it only after verifying that no writer still owns it. File age alone is not safe evidence of abandonment.
