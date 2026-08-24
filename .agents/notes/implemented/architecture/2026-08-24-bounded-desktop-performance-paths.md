# Agent Note: Bounded desktop performance paths

Status: implemented

English | [中文](2026-08-24-bounded-desktop-performance-paths.zh.md)

## Problem

The desktop Web composition had seven high-cardinality paths whose work or retained state grew without an operational bound: Host and browser event queues, JSON-backed projection checkpoint rewrites, session-list catalog scans, browser Session materialization, Electron diagnostic writes, sidebar DOM rows, and tool-result argument lookup. Each path was acceptable with a small session history, but ordinary long-lived use could convert background traffic, reconnect, opening the application, or rendering one large Workspace into increasing latency and memory use. Several paths also hid their recovery behavior: dropping an overflowing event prefix or serving mixed pagination generations would be fast but incorrect.

The session event log remains the authoritative record. Derived indexes, caches, browser objects, and mounted rows may be discarded or rebuilt, but performance limits must not silently remove durable history, lose addressed live state, mix pagination generations, or change Workspace ordering and drag behavior.

## Decision

1. Host frame queues and decoded browser WebSocket inboxes use configurable bounded rings, with shipped capacities of 8,192 messages. Overflow fails the entire connection generation and reconnects both downlinks so their authoritative baselines repair the gap. Array head removal is not used.
2. The Web composition routes only the high-frequency `session_projcache` storage domain to SQLite. Each checkpoint is a row-level UPSERT in `storages/session-projections.sqlite3`; other storage domains remain on the JSON backend. The projection cache remains derived from the session log, so an inactive legacy JSON cache does not require migration.
3. `session.list` reads a persistent SQLite index ordered by direct-human-prompt time and Session id. A page reads `limit + 1` indexed rows instead of materializing the persistence catalog. The first page leases one generation; short-lived row versions keep continuation pages immutable until the cursor TTL expires, after which expired generations and versions are pruned. A clean shutdown permits immediate startup service plus background reconciliation. A new index or unclean shutdown reconciles before readiness. Exact-id history and resume lookup use persistence inspection rather than catalog enumeration.
4. The browser list remains a metadata projection. `SessionRuntime` lazily materializes Session objects and agent scopes, keeps the current and explicitly watched Sessions protected, and evicts least-recently-used offstage objects over the configured resident limit of 8. Eviction releases event windows, history, projections, and scoped resources; stream-only pending requests and queue snapshots remain keyed by Session id and seed a later rebuilt instance.
5. Electron main and Harness logs use persistent asynchronous writable streams with backpressure. Rotation keeps one bounded current file and one predecessor, closes the Windows handle before rename, and drains both streams during graceful shutdown. Startup retention scanning stays synchronous because it is bounded boot work; steady log traffic performs no synchronous filesystem writes on the main thread.
6. Grouped and flat sidebar trees virtualize above 80 logical rows. Only the viewport and overscan range are mounted, while complete logical ordering remains available for sort, accessibility position metadata, and Workspace drag hit-testing.
7. A history page indexes tool-call arguments in one forward pass before projecting tool results. Tool result lookup is therefore linear in the page event count instead of repeatedly scanning the preceding range.

## Alternatives considered

- Increasing queue sizes or dropping the oldest frames was rejected. A larger unbounded trend only delays exhaustion, while silent loss makes the client state unverifiable. Reconnect provides an existing repair path.
- Keeping projection checkpoints in the shared JSON backend with longer write intervals was rejected. It lowers frequency but preserves whole-medium rewrite amplification and increases cold-replay work.
- Rebuilding and sorting the complete session catalog for each first page, or retaining whole in-memory snapshot arrays, was rejected. Both tie startup and pagination memory to total session count. Stateless keyset cursors without version retention were also rejected because mutation between pages would skip or duplicate rows.
- Keeping every browser Session alive and limiting only history page size was rejected. Event windows, projections, subscriptions, and scopes would still accumulate per visited session.
- Debouncing synchronous Electron writes was rejected. It still blocks the main thread during flushes and complicates loss-free shutdown.
- Rendering every sidebar row and relying on CSS containment was rejected. Hidden DOM nodes still incur React, layout, accessibility-tree, and memory cost.
- Caching individual backward tool-call searches was rejected in favor of one explicit page index whose time and memory bounds are easy to inspect.

## Consequences

The steady-state event and browser-object memory ceilings are deployment-visible configuration. Event overload now causes a deliberate reconnect, so callers may observe a recovery pause rather than indefinite memory growth. Cursor leases temporarily retain changed session-index rows; their lifetime is bounded by `sessionListSnapshotTtlMs`, and cursors remain process-local. SQLite adds two derived Web files under the user's normal DSH home: the session-list index and projection checkpoint database. Either can be reconciled or rebuilt from authoritative session state.

The sidebar still computes logical grouping and ordering over all list summaries, but React and DOM materialization scale with the viewport. Protected current or watched Sessions may temporarily keep the resident count above the offstage limit; unprotected objects converge to the configured ceiling. Graceful desktop shutdown waits for diagnostic streams, while abrupt process termination retains the ordinary operating-system durability behavior of asynchronous files.

Focused regression tests assert queue overflow and FIFO order, index `limit + 1` pagination and immutable generations, exact-id lookup without catalog enumeration, bounded Session residency with state rebuild, asynchronous log rotation and backpressure, bounded sidebar DOM with complete logical cardinality, SQLite projection composition, and one-pass tool-call parsing. The opt-in browser performance scenario records the logical sidebar cardinality separately from mounted rows.
