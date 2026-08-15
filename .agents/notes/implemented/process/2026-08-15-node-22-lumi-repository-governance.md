# Agent Note: One Node 22 runtime and Lumi repository governance

Status: implemented

English | [中文](2026-08-15-node-22-lumi-repository-governance.zh.md)

## Problem

The inherited repository advertised Node 24 and later even-numbered releases after repeated Node 24 worker crashes had already made the primary test path unreliable. Product code also lived outside the standard root build, the npm release family treated private applications as publishable members, pull requests did not require a native Lumi Windows result, and fork workflows targeted the upstream branch or depended on upstream-only labels, projects, secrets, and actors. A successful upstream Harness gate could therefore say nothing about whether this repository built, tested, released, or even named Lumi coherently.

## Decision

This note supersedes the multi-runtime range and CI matrix in [the Node engine-floor decision](2026-07-06-node-engine-floor.md). The dependency-floor rationale remains valid, but the repository now supports only the Node 22 LTS line: `engines.node` is `^22.19.0`, development and every owned CI workflow use exact Node `22.23.2`, and `@types/node` remains on 22.x. The Python single-executable workflow also targets `node22-*`, so the embedded runtime cannot silently diverge from development and CI. Node 24 and Node 26 are not compatibility lanes; adding a later runtime requires a new measured decision rather than an open-ended engine range.

The product name is Lumi throughout current packages, profile ids, settings namespaces, routes, commands, docs, tests, artifacts, and repository metadata. `main` is the product branch and every owned push trigger targets it. The official `upstream/master` ref remains only the fetch-only synchronization input because that is the upstream repository's actual branch; it is never a publication or required-check target for Lumi.

The root `build` includes Host libraries, client libraries, the Web application, and the Electron desktop host. The DSH npm release family discovers explicit package/application roots but skips every `private: true` manifest, which keeps the installable desktop and its profile bundle in the source composition without sending them to npm. A native Windows CI job runs the complete Lumi compatibility and Electron path and contributes to the aggregate required result. The separate desktop release workflow verifies configuration without packaging by default and gives write permission only to its protected, exact-tag publication job.

The `lumi-desktop` bundle compiles in the Host graph because its TypeScript source contains only the profile marker and invariant companion. Its Lumi packages remain runtime composition dependencies in `package.json`, not Project References of that marker project. `lumi-character` instead exposes explicit Host and Client compiler leaves: the Host leaf owns local settings, packs, routes, and its invariant; the Client leaf owns DOM speech, browser state, and components; bond, manifest, built-in pack, and settings modules are identical inputs to both. The compiler-face constraint checks each referencing project's declared face, rejects Host entry into a Client-only project, and requires the matching leaf of every split project. A clean checkout therefore proves the Host-first generated-contract order instead of succeeding through stale `lib/` output.

Windows acceptance uses PowerShell rather than assuming Bash exists. The shipped full presets, headless example, Code Mode worker tests, and loader round trip select the host-native shell as one complete executor/tool pair; the deliberately Bash-specific minimal preset remains explicit. Source-launched child processes pass `file:` URLs to Node's `--import`, LSP acceptance invokes the language server's JavaScript entry through the current Node executable instead of a platform-specific `.bin` wrapper, and process-owning tests wait for child exit before removing Windows working directories.

Issue automation is repository-local. Its configuration names `CheshireMew/dsh-Lumi`; title, body, and label policy runs with the repository token, while organization Project fields are optional and disabled when the repository has no configured Project. No workflow asks for an unavailable upstream GitHub App actor or secret. An explicit Project lifecycle operation still fails loudly instead of pretending it synchronized metadata.

The root README, bilingual Lumi guide, website navigation, package metadata, issue links, and release configuration all point at the current repository. The GitHub repository remains an external delivery surface: labels, branch rules, description, topics, environments, signing secrets, release assets, and visibility are verified or changed explicitly through GitHub and are never inferred from local files.

## Verification

Workflow contract tests assert the main branch, exact Node 22 runtime, native Lumi Windows job, release permissions, GitLab Python carrier targets, and independent issue policy. Release-family tests prove private desktop manifests are absent from npm members. Keyless Windows E2E covers preset composition, Code Mode foreground/background cancellation, a persisted loader shell round trip, ACP source launch and teardown, and a real TypeScript language server. Snapshot replay keeps the portable Bash transcript for POSIX hosts and selects a checked-in PowerShell override and expected transcript on Windows, so each platform validates the tool exposed by its production composition instead of normalizing one shell into another. The static Lumi release verifier checks version identity, app id, product name, icon, signing requirements, update-signature verification, draft provider, and exact tag without producing an installer. The final repository audit pairs these source results with remote default-branch, metadata, labels, rules, workflow, and release evidence.

The Project Reference face tests include the clean-build failure mode: a Host aggregate may consume shared projects and matching Host leaves, but it rejects a Client-only single-config target before a release checkout can depend on generated client contracts that do not exist yet. Event graph generation binds isolated Host and Client semantic programs and merges their relation sets, so fixing the compiler graph cannot silently erase Client dispatchers and listeners from published documentation.

## Alternatives considered

**Keep Node 24 primary and reduce Vitest concurrency.** Rejected because the observed failure is a native Node 24 CJS-lexer abort rather than a repository assertion or an ordinary resource timeout. Lower worker counts reduce frequency but do not turn that runtime into deterministic acceptance evidence.

**Advertise Node 24 while developing on Node 22.** Rejected because a supported engine must have an owned compatibility lane. Advertising an unverified runtime recreates the gap this decision closes.

**Leave Lumi as opt-in scripts outside `build` and CI.** Rejected because the standard repository success path would continue to omit the product users receive.

**Publish every workspace discovered under `apps/` and `packages/`.** Rejected because Electron applications and composition-only private bundles are delivery artifacts, not npm packages; making them public only to satisfy a generic release loop changes the wrong layer.

**Keep upstream issue automation and disable failing steps.** Rejected because silent skips would report policy success without enforcing any local issue state. The independent repository policy is complete on its own; unavailable Project metadata is an explicitly absent optional capability.

## Consequences

Every local and owned automation path now answers for the same runtime, branch, repository, and product. Standard build and CI failures include Lumi, npm publication excludes non-npm artifacts, and issue automation can operate with ordinary repository permissions. The trade-off is deliberate: Node 24+ features cannot enter the source while Node 22 is the supported line, and public installer updates remain blocked until the repository or another release provider exposes assets to intended users and protected signing credentials exist.
