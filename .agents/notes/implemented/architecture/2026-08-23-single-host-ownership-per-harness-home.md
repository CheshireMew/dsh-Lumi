# Agent Note: Single Host ownership per Harness home

Status: implemented

English | [中文](2026-08-23-single-host-ownership-per-harness-home.zh.md)

## Problem

Product profiles share Sessions, storage domains, settings, credentials, projections, feedback queues, and Workspace records under `$DSH_HOME`. Their durable backends can make individual writes atomic, but the corresponding live owners and mutation queues are process-local. Two Host processes using one home could therefore accept conflicting writes, serve divergent in-memory snapshots, or let one process delete a Session that the other still owns. Protecting only JSON files or SQLite transactions would not coordinate those lifecycle relationships.

The ownership mechanism must also recover safely after termination. A persistent lock file, PID check, or heartbeat can outlive its owner, reuse an unrelated PID, or guess that a paused process is dead. Startup must reject a live owner before profile initialization, fallback-link healing, or home configuration access, while a crashed owner must not require manual cleanup.

## Decision

Every product profile boot through `runProfile` acquires exclusive ownership of the canonical `$DSH_HOME` before profile composition or any profile/home write. Canonicalization creates the directory, resolves filesystem aliases, and folds case on Windows when deriving the endpoint identity. Ownership covers the whole home rather than one profile because profiles share the same durable and live authorities. Different canonical homes may run concurrently.

Windows uses a named pipe derived from the SHA-256 hash of the canonical home. Other platforms try a bounded deterministic sequence of loopback TCP ports. A listener returns a bounded, versioned local handshake containing the home hash, PID, profile, and start time. A contender treats a matching endpoint as a live owner and exits nonzero with those details. The non-Windows handshake distinguishes an unrelated listener that happens to occupy a candidate port and continues to the next candidate.

The operating system owns the listening endpoint, so process death releases it without a stale-file decision. Normal completion, SIGINT, SIGTERM, fail-loud teardown, composition failure, and boot failure release ownership after the plugin tree has disposed. The endpoint is unreferenced so it cannot keep a completed one-shot process alive. An unexpected endpoint error or close while the Host is running is fatal because the process can no longer prove exclusive ownership.

The guarantee applies to the shipped CLI and Lumi Desktop because both mount profiles through `runProfile`. Config dumps and plugin management do not mount a Host and do not acquire ownership. Direct Cordis embeddings and bespoke storage roots bypass the product launcher; they remain responsible for one-writer ownership or a complete cross-process coordination protocol.

## Alternatives considered

**Lock each persistence backend independently.** Rejected because storage-domain queues, live Session ownership, projection state, feedback queues, and settings observations would still disagree across processes. Backend locks could serialize bytes without producing one coherent Host authority.

**Use one lock per profile.** Rejected because different profiles resolve the same `$DSH_HOME` and can write the same Sessions, settings, credentials, and storage domains.

**Use a lock file with PID or heartbeat recovery.** Rejected because crash recovery would depend on stale-file cleanup and liveness guesses. An operating-system-owned listening endpoint has automatic crash release and directly answers ownership probes.

**Let a second Host attach to the first.** Rejected as a launcher behavior because attaching requires an authenticated discovery and control protocol that does not exist. Browser clients can already use an existing Web Host without creating another Host.

## Verification

Unit coverage acquires two distinct homes concurrently, rejects a second owner for the same canonical home with live owner details, proves release is idempotent, and transfers ownership after release. A real child process is terminated forcefully to verify that Windows releases the named pipe without an explicit cleanup path.

A keyless product snapshot starts a real source and built `dsh` profile against a temporary home, observes the first Host becoming ready, verifies that a second Host exits with the normalized ownership diagnostic, force-terminates the owner, and verifies that a replacement Host becomes ready against the same home.

## Consequences

The shipped product has one authority for all state under a Harness home. Backends retain their documented direct-embedding limitations, but those limitations no longer describe ordinary CLI or Desktop deployment. A user who wants another independent Host must select another `$DSH_HOME`; another browser window connects to the existing Host instead.

The lease is a startup and lifecycle invariant, not a durable data format. It adds no file to the home, changes no storage schema, and requires no migration or stale-lock recovery command.
