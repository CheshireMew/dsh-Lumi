# Agent Note: Durable Session lifecycle and explicit retention

Status: implemented

English | [中文](2026-08-23-durable-session-lifecycle-and-retention.zh.md)

## Problem

The durable Session lifecycle stopped at create, append, inspect, and resume. Archive could hide a Session but had no restore or permanent-delete path, so the shared Harness home grew without a product-owned retention action. Workspace accounts, projection caches, and feedback tables could retain references after out-of-band removal. The client-facing Session baseline also returned the whole catalog in one response.

Deletion has stronger lifecycle requirements than removing a storage row. A live Session, a write controller retiring from a live owner, or an unpublished Session being prepared for resume still owns the identity. A parent may have persisted descendants. Derived stores must converge if the process stops after the authoritative log commit but before cleanup. Pagination must not mix fresh observations: a Session promoted between pages can otherwise move ahead of the cursor and disappear from an initial client baseline.

## Decision

Retention is explicit. Archive is reversible and retains the log indefinitely. Permanent deletion occurs only through `session.delete` or the underlying `SessionPersistence.delete`; there is no age-based or storage-pressure cleanup. The Workspace browser renders archived Sessions in a dedicated trailing group or section with Restore and Delete forever actions. The destructive action uses a blocking confirmation and requests recursive deletion, while a failed operation keeps the confirmation open.

`SessionPersistence.delete(id, signal?)` is the storage authority. `PersistenceCoordinator` serializes it with same-id append, repair, preparation, and retirement. It rejects a live identity and every active preparation phase (`loading`, `committing`, or `reserved`) before the delete can queue behind preparation I/O. This preflight prevents deletion from cutting between a preparation load and its reservation commit. Unknown materialized ids reject with `SessionPersistenceNotFoundError`. Cancellation is observed while queued and immediately before backend work; once a backend delete starts, its commit is indivisible.

JSONL removes the fixed transcript and `session.index.json`, then removes only an empty Session directory; unknown files remain untouched. SQLite deletes the `sessions` row in one transaction and lets its foreign key cascade event rows. After the authoritative commit, the coordinator emits `session-persistence/deleted`. Projection cache, feedback, and Workspace consumers remove their records on that event and independently prune absent Session ids at startup, covering a crash between the authoritative delete and derived cleanup.

The Host `session.delete` method builds the complete persisted/live lineage before writing. Any live root or descendant rejects with no deletion. A non-recursive request with descendants rejects. An authorized tree is deleted child-first in deterministic id order. Cancellation may stop between committed identities; retrying the same recursive request treats already-absent descendants as completed and converges on the remaining tree. `host/session-deleted` is a durable-removal frame and remains distinct from `host/session-removed`, which only reports activation teardown.

`workspace.unarchiveSession` idempotently removes one id from the durable archive set. Workspace startup always refreshes the persistence header catalog and prunes missing account and archive references before publishing entities; the deletion event applies the same cleanup during a running process.

`session.list` is a bounded snapshot-pagination protocol: 50 summaries by default, at most 100 per page. The first page sorts one complete observation by `updatedAt` descending and Session id ascending. An opaque cursor addresses an offset in that immutable observation, so later pages cannot omit or duplicate a Session because live activity changed its order. Incomplete observations have configurable `sessionListSnapshotTtlMs` and `sessionListMaxSnapshots` bounds. An expired or evicted observation returns `session-list-cursor-stale`; the client discards the incomplete attempt and restarts once from page one. Malformed cursors return `session-list-cursor-invalid`, repeated cursors fail closed, and the client publishes only a complete page sequence.

## Failure and recovery

Recursive deletion preflights the entire lineage before its first commit, but the multi-log operation is intentionally not one cross-backend transaction. Its child-first order plus already-absent convergence makes interruption recoverable without a second deletion ledger. Derived cleanup is also post-commit and may fail independently; startup reconciliation treats persistence as the authority and removes residue. No cleanup path recreates a deleted log or reports success before the storage commit.

## Alternatives considered

**Automatically expire old archived Sessions.** Rejected because archive is a reversible organization action, not consent to destroy history. An explicit permanent-delete action gives the local desktop a predictable retention policy without a hidden timer.

**Cascade Session deletion from Workspace deletion.** Rejected because a Workspace is registration metadata. Removing it preserves the directory, user files, Sessions, and logs; permanent Session deletion remains a separate confirmed action.

**Recompute every continuation page from current state.** Rejected because mutable `updatedAt` ordering can move an unseen Session before a prior keyset cursor. Binding the cursor to one bounded observation preserves a complete reconnect baseline.

**Make recursive deletion one global transaction.** Rejected because JSONL identities are independent filesystem artifacts and the persistence seam supports multiple media. Deterministic child-first commits with retry convergence give every backend the same recoverable behavior.

## Verification

The persistence contract covers unknown ids, live ownership, post-commit event order, and lazy identities. Coordinator tests cover deletion racing retirement and every resume-preparation phase. JSONL tests cover transcript/index removal, Windows directory semantics, and preservation of unknown files; SQLite tests cover transactional cascading deletion. Workspace, projection-cache, and feedback tests cover event cleanup and startup pruning.

ApiProxy tests cover immutable pagination across timestamp ties and intervening publication, malformed and evicted cursors, non-recursive refusal, live-descendant zero-write preflight, deterministic child-first deletion, and cancellation/retry convergence. Client runtime tests cover full-page hydration, stale-snapshot restart, partial-page failure retention, repeated-cursor refusal, unary deletion projection, and external deletion frames. Workspace-browser tests cover archived sections, restore, permanent-delete confirmation, and visible failure recovery.

## Consequences

The product now owns the complete ordinary Session retention path: archive, restore, confirmed permanent deletion, derived cleanup, crash reconciliation, reconnect frames, and a bounded client baseline. The low-level `list()` and `listSnapshots()` reconciliation operations still observe the complete persistence catalog; making their physical discovery sublinear requires an indexed query operation with different semantics and does not weaken the bounded public wire.

SQLite advances its storage schema for the durable activity column included in this lifecycle batch. JSONL keeps its transcript format and stores the activity index as a derived sidecar. `SESSION_FORMAT_VERSION` remains unchanged because deletion, archive membership, and list cursors do not alter Session-event envelopes.
