# Agent Note: Windows compatibility for canonical repository gates

Status: implemented

English | [中文](2026-08-14-windows-gate-compatibility.zh.md)

## Problem

The repository's canonical snapshots and aggregate gates must validate the same product behavior on Windows without changing the shipped Windows shell or recording a second result for every POSIX fixture. Several test launchers assumed `bash` was already on `PATH`, JSONL hydration inserted native paths as unescaped text, and nested JSON strings exposed a second path-escaping level. The unit-test aggregate also launched sixteen fork workers while `check:all` ran several process-heavy gates concurrently, causing Git, Oxlint, Lefthook, and lifecycle tests to exceed deadlines that remain sufficient when the suites own the machine resources they measure.

## Decision

Source-mode example launch resolution prepends the Git for Windows Bash directory on Windows. This applies to the shared Loader-smoke, ACP, SDK, and Headless subprocess paths while leaving product profiles unchanged: shipped Windows profiles continue to select PowerShell and the Windows ACL runner. A platform-specific Headless fixture asserts that selection directly, and the SDK persistent-Bash scenario is explicitly POSIX-only because the underlying terminal-inspection provider rejects Windows by design.

Portable session fixtures are realized as JSON values rather than text substitution. String fields that themselves contain JSON are decoded recursively, tokens are replaced at the semantic value, and each layer is serialized again. Snapshot normalization recognizes both native filesystem spellings and their JSON-string spellings; canonical mode collapses one or more Windows separators to one `/` only inside cwd-rooted paths. One committed fixture therefore remains valid across supported hosts without accepting malformed JSON or hiding unrelated backslashes.

The root `devEngines.runtime` declaration makes pnpm install and lock Node 22.23.2 for development scripts without narrowing the published packages' `engines.node` support range. This keeps the gate off Node 24's CJS-lexer native crash, which can terminate an isolated Vitest process without an assertion failure. Node 22 goal snapshots disable only `ExperimentalWarning` for their child process, so the SQLite stability notice cannot violate an assertion that reserves stderr for product output. Windows runs the unit inventory as eight sequential Vitest shards with one fork worker each. This bounds process creation in Git, compiler, real-CLI, and subprocess suites; an explicit test filter remains one ordinary invocation. The Oxlint fix-retry subprocess assertion allows 20 seconds under aggregate gate load, consistent with the neighboring process-heavy cases. The local `check:all` aggregate runs one top-level gate at a time on Windows, because its child gates already own internal parallelism and several spawn process trees. Other platforms retain their existing worker limits. Product timeouts do not change. If an ACP child-log poll cannot finish even once before its scenario deadline, the snapshot harness still reports the child, turn, and requested deadline instead of leaking Vitest's generic wait timeout. The Web scaffold rejects OS-assigned ports on Chromium's blocked-port list and boots a fresh temporary Host before installing replay fixtures. Atomic file replacement retries bounded `EACCES`, `EBUSY`, and `EPERM` rename failures, matching the existing vendored Loader writer so a temporary Windows antivirus, indexer, or watcher handle does not reject an otherwise valid setting change. Every settings-browser case owns a fresh temporary Host, settings directory, and browser page, so a failed overlay or preference write cannot contaminate the next case. The dark-theme case waits for a light preference to persist before selecting dark; durable settings-file assertions allow 30 seconds so a slow synchronized Windows volume does not turn a completed Host write into a false failure. Those assertions parse the YAML document and compare namespace fields instead of depending on block or inline serialization.

The client-domain graph gate accepts only the exact cross-domain edges already present in the official tree and rejects every new edge; removing an accepted source edge needs no allowlist update. The vendor-rescope gate likewise excludes the exact files where bare `cordis` is a runtime id, locale namespace, preset id, or product term rather than an npm package specifier. Both gates remain active instead of failing on their own official baseline.

## Verification

The Windows keyless snapshot lane covers the full ACP scenario table, SDK replay, Headless profile command, translation prompt, and bundled-skill snapshot. Focused normalization coverage pins Windows paths inside nested JSON strings and rejects Chromium-blocked port 4045 before browser launch. The unit-test aggregate exercises the Git worktree, merge-driver, installer-lock, Oxlint ownership, generated client catalog, and real subagent lifecycle files under the Windows worker limit. `check:all` remains the final aggregate acceptance command.

## Alternatives considered

**Increase test timeouts.** The failures came from competing process trees rather than slow product behavior. Longer deadlines would hide resource saturation, delay genuine failures, and leave the same nondeterminism on busier Windows hosts.

**Record Windows copies of every portable snapshot.** Most scenarios have identical semantics across hosts, so parallel fixture trees would duplicate expected behavior and drift. Platform-specific fixtures remain limited to behavior that intentionally differs, such as the shipped PowerShell profile.

**Disable baseline-failing static gates.** Turning off the client-domain or vendor-rescope checks would also admit new violations. Exact inventories preserve the gates' value while making the inherited debt visible and allowing it to shrink without maintenance work.

## Consequences

Windows validates the canonical repository behavior without changing production shell selection or maintaining a parallel snapshot corpus except where the product surface is intentionally platform-specific. Aggregate gates take longer on Windows, but failures retain their diagnostic meaning and no longer depend on transient process saturation. The explicit client-domain and rescope exception lists are reviewable debt inventories: new violations fail immediately, while deleting existing debt always improves the result.
