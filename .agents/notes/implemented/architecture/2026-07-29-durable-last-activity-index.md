# Agent Note: Record last activity in the session index

Status: implemented

English | [中文](2026-07-29-durable-last-activity-index.zh.md)

## Problem

Before this decision, a cold (persisted, unattached) session had no authoritative stored answer to "when did the user last prompt here". `dsh-host-apiproxy` served `updatedAt` from the optional projection cache's `lastPromptAt`, falling back to `createdAt`, and the Web client sorted its Session tree by that value. The cache is fail-soft and checkpointed asynchronously, so a missing or delayed row made a recently prompted Session sort too old.

The gateway previously used JSONL artifact mtime when available. mtime answers a different question: when the artifact was last written. Every durable write refreshes it, including a truncate-repair of a torn tail, synthetic closers that balance an interrupted turn, and the [`session/end-seed` boundary](2026-07-30-session-end-seed-log-boundary.md) appended during pickup. That approximation promoted a Session merely because it was opened. The [bounded cold blank verification](../bug-fix/2026-08-13-bounded-cold-blank-verification.md) removed mtime ordering and accepted the cache's conservative "too old" failure direction as an interim tradeoff.

An attached summary can fold the live event log and select the latest human-authored `user/message`, but the cold path deliberately does not read large logs. Reading every log to compute `updatedAt` would make `list()` scale with total conversation bytes rather than Session count. The 1 KiB cold read used for metadata verification makes eligible small-artifact recency exact, but it does not make large-log ordering exact.

Exact cold ordering requires persistence to return activity metadata with each listed log revision rather than leaving the gateway to approximate it.

## Decision

`SessionPersistenceSnapshot` carries `lastPromptAt` beside the header and revision. `advanceLastHumanPromptAt()` in `dsh-session` owns the rule: only a `user/message` whose `source.kind` is `user` advances the time. The attached Session summary and persistence coordinator both call this reducer, so injected user messages, pickup boundaries, recovery closers, and other writes cannot affect ordering.

The coordinator retains the exact time in each per-id durable state. It computes the post-batch value before calling `appendBatch` and the post-repair value before `commitRepair`; a backend persists that value with the log mutation.

- **SQLite** stores `last_prompt_at` in `sessions` and updates it in the same transaction as event INSERTs, repair DELETEs, closers, and the revision increment. The table change advances `SCHEMA_VERSION` to 16; every other nonzero version is rejected under the pre-release no-migration policy.
- **JSONL** keeps the immutable header and append-only transcript. A replaceable `session.index.json` sidecar contains the transcript revision, `lastPromptAt`, and an integrity digest. The transcript becomes durable first. A matching sidecar gives constant-size listing work; a missing, stale, malformed, or integrity-damaged sidecar triggers a revision-stable transcript read, exact reducer fold, and atomic sidecar replacement. Sidecar write failure after append is logged rather than turning a committed append into a retry that would duplicate event seqs.

`dsh-host-apiproxy` uses the indexed value for every cold `updatedAt`. Projection-cache metadata remains relevant only to blankness; recency no longer depends on cache installation, checkpoint timing, artifact size, or `locate()` support. A pre-index JSONL artifact is reconstructed on its first listing. A pre-column SQLite database is rejected because schema migration is deliberately unsupported before release.

## Alternatives considered

**Read the log on the cold path.** Correct by construction and needs no format change, but it defeats the header-only listing: `list()` would scale with total log size, and the web session tree fans out over every session in the store. This is the option the mtime approximation exists to avoid.

**Keep mtime and exclude boundary writes from it.** Rejected as impossible rather than undesirable: mtime is the filesystem's, not the backend's. Nothing short of restoring the timestamp after every boundary write would preserve it, and that races any concurrent reader and lies about the artifact.

**Write the boundary only when repair occurred.** Would reduce the frequency, and the [boundary note](2026-07-30-session-end-seed-log-boundary.md) already rejected it: the predicate must hold for an orderly restart too. Trading a correctness invariant for timestamp accuracy is the wrong direction.

**Derive activity from a projection cache.** `session-projection-cache` folds tails past a watermark without changing the persistence format, but it is optional and fail-soft. Its absence or checkpoint delay makes ordering depend on cache availability and freshness, so it cannot provide an exact listing value.

## Consequences

- Cold Session ordering is exact without reading ordinary large logs and remains unchanged when a Session is resumed and abandoned without a new prompt.
- JSONL normally adds one small mutable file per materialized Session. Recovery may parse an affected transcript once, then returns listing to per-Session metadata work.
- `listSnapshots()` has a stronger provider obligation: each row's revision and `lastPromptAt` must describe the same exact stored prefix.
- Adding a new direct-human message source requires changing the one shared reducer, not separate gateway and backend predicates.

## Verification

- The shared persistence contract proves that injected user messages and non-prompt events do not advance the index, while a later direct human prompt does, for memory, JSONL, and SQLite providers.
- JSONL tests cover absent, malformed, integrity-damaged, stale, and reopened indexes; a revision mismatch forces exact reconstruction.
- SQLite tests cover transactional activity updates and pin `SCHEMA_VERSION = 16`, including rejection of older and newer schemas.
- ApiProxy cold-list tests supply persistence-index rows and prove that live attachment during an asynchronous blank probe still replaces the cold summary.
- The focused persistence and gateway suites pass 399 tests, and the repository typecheck passes with the expanded snapshot record.

## Risks

**Continuous external writers can delay reconstruction.** JSONL obtains a revision-stable transcript before rebuilding the index. A writer that never leaves one read/check interval stable can postpone listing; the storage ownership policy must prevent competing live writers rather than weakening the revision check.

**Recovery cost follows the damaged transcript.** A missing or invalid JSONL index requires one complete parse, including decompression. This is exceptional recovery work; ordinary listing remains independent of transcript bytes.

## Related

- [Bounded cold blank verification](../bug-fix/2026-08-13-bounded-cold-blank-verification.md) — keeps direct cold reads limited to small-artifact blankness verification.
- [The end-seed log boundary](2026-07-30-session-end-seed-log-boundary.md) — one of the non-prompt writes that makes mtime unsuitable.
- [Session persistence](2026-06-14-session-persistence.md) — owns the append-only transcript and crash-recovery rules.
- [Shared persistence write coordinator](2026-06-18-shared-persistence-write-coordinator.md) — owns the post-batch and post-repair index value passed to backends.
