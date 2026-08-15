# Agent Note: Development-stage verification budgets

Status: implemented

English | [中文](2026-08-16-development-stage-verification.zh.md)

## Problem

The pre-release repository treated full per-file coverage, complete application matrices, publication checks, and remote CI completion as ordinary implementation evidence. A broad change could therefore start expensive validation before its code and scope were stable, discover another concern, and invalidate the same full run several times. Passing those checks proved the tested revision, not that the unfinished product was complete.

## Decision

Active development validates one logical change batch on the current host. The validation phase first reads the latest available completed failure from public CI once and classifies relevant evidence as a product, test-infrastructure, or environment failure. Pending and running remote jobs are not monitored by an ordinary implementation task. A successful non-force push ends the task and reports remote checks as asynchronous; another platform or active CI monitoring requires an explicit user request.

Focused specs and the narrow type, build, documentation, or smoke consumer are the normal development checks. Full coverage, complete snapshots and Electron E2E, real-API runs, visual and performance matrices, packaging, signing, release, and non-host platform checks are milestone evidence. They run at code freeze, a release candidate, an explicit request, or after a focused failure demonstrates system-wide impact. Any check expected to exceed 15 minutes is announced with its command, purpose, and estimate before it starts.

The public `test:coverage` command and CI both use the coverage gate runner. Instrumented source tests and compiler- or subprocess-heavy suites with no unique threshold contribution run in parallel lanes. On Windows under Node 22, ordinary fork-isolated tests use two workers while the explicit process-bound inventory remains single-worker inside sequential bounded shards. This retires the global single-worker restriction without reintroducing the Node 24 worker-thread path.

## Verification

The gate-runner and unit-invocation planning specs protect the existing lane and shard identities. A focused representative shard compares the Windows worker budgets under the pinned Node runtime; documentation and Agent Note checks cover the standing development contract. Full coverage is deliberately not part of this change's local completion evidence.

## Alternatives considered

**Run the complete repository after every change.** Rejected because repeated full results become stale whenever the same task continues editing, and most small changes do not affect every consumer.

**Remove the 100% coverage policy.** Rejected because the policy remains useful at milestones and in CI; the defect was its frequency and execution path, not the threshold itself.

**Wait for every remote job after pushing.** Rejected because the public runner owns asynchronous validation. Ordinary implementation reports the queued evidence and releases the task instead of turning CI latency into development wall time.

## Consequences

Small changes finish after focused local evidence, and repository-wide checks run once at an explicit stability boundary. Remote failures remain visible at the next validation phase without keeping the originating task open. Milestone and release claims still require their named evidence, but unfinished feature work no longer inherits those claims automatically.
