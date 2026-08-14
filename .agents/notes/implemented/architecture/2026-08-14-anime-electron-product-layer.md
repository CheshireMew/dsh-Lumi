# Agent Note: Electron anime product layer over the official Web UI

Status: implemented

English | [中文](2026-08-14-anime-electron-product-layer.zh.md)

## Problem

An anime desktop presentation needs native window behavior, a durable character domain, and a substantially different layout without taking ownership of the Harness features that the official Web UI already implements. Copying the frontend would turn every official UI change into a manual port, while launching an unrelated backend would split profiles, sessions, settings, and plugin discovery.

## Decision

The product uses Electron as a narrow desktop host over the official Web app. A dedicated Electron utility process boots the `anime-desktop` profile through the public CLI profile-boot API with `dsh-base`, `dsh-web-app`, and the additive `@dsh-anime/bundle-desktop`. The Web server binds to `127.0.0.1` on an operating-system-assigned port and reports readiness through a structured process message.

The official layout plugin owns a stable `LayoutRoot`, its layout store, and all official child slots. It declares the single `layout.frame` presentation slot and installs `AppFrame` at priority `0`. `@dsh-anime/client-shell` installs a frame at priority `-100`, so product presentation replaces arrangement only. Removing the product frame reveals the official layout with the same session and panel state. Tool inspection routes through the official conversation owner to select the call and open the official `DetailsPanel`; the anime frame supplies only the drawer placement.

`@dsh-anime/client-character` owns Character Pack v1 validation and read-only serving, system speech, character state projection, and bond progress in the `ui-anime` settings namespace. The pack protocol includes canvas placement, layered body, expression, mouth and effect assets, every state with animation and fallback timing, idle actions, and bilingual level unlocks. These remain browser/settings sidecars: they do not alter model prompts, model history, session persistence, tools, or provider selection. The product observes `message-feedback/change` only after the official feedback mutation succeeds, and persists credited turn and feedback identities so reconnects cannot award them twice.

## Desktop boundaries

Electron owns the single-instance lock, frameless window, startup page, utility-process lifecycle, daily logs, and opening product folders. The sandboxed preload exposes a fixed API for those operations. Context isolation is enabled and Node integration is disabled; product components have no Electron import and the ordinary browser build remains usable.

The lifecycle controller owns a 30-second startup deadline, two rapid-disconnect retries, a ten-second stability reset, structured restart and shutdown commands, and an eight-second graceful-close deadline before termination. Fatal startup messages and exhausted retries keep the application open on a recovery page with retry, diagnostic-copy, and log-folder actions. The desktop and CLI share `$DSH_HOME`; the desktop adds only the character-pack and log directories. Window placement is validated and atomically stored in Electron `userData`, while profile initialization preserves later user-owned profile and home patches.

Electron's utility-process Node runtime does not expose Cordis Loader's Node-internal ESM loader. Application boot therefore supplies an installed-host `importModule` callback through Loader's public API when internals are absent. Config-only HMR remains active with no module roots and does not require the internal module cache.

## Upstream maintenance

The official repository is the fetch-only `upstream` remote, `upstream-base` fast-forwards to `upstream/master`, stable product work lives on `main`, and Git `rerere` records repeated conflict resolutions. `.upstream.json` records the official target, validated commit, and high-conflict paths. The guarded sync command refuses a dirty tree, creates `codex/sync-YYYYMMDD-<sha>` from `main`, merges `upstream-base`, preserves conflicts, runs the product and official gates, and records a dated report. Only a completely successful run advances the validated records. Official bundle rows stay untouched; the anime bundle is the complete product roster difference.

Windows runs the canonical POSIX-recorded Web replay corpus through Git for Windows Bash and a test-only pass-through runner inside fresh temporary workspaces. The scaffold selects Bash only in a copied preset catalog, maps fixture `/tmp` paths for native Python, normalizes platform paths in snapshots, and restores its environment at teardown. Native Windows acceptance scenarios opt out of that compatibility path and retain PowerShell plus the ACL runner. Shipped presets, product shell selection, and product confinement remain unchanged.

## Verification

Focused tests cover layout-frame fallback and the unchanged official frame DOM, real install-anchor profile boot, installed-host nested module resolution without Loader internals, config-only HMR, Character Pack v1 rejection and fallback, state priority and release timing, speech sanitation and playback controls, bond awards and deduplication, Host settings convergence, desktop protocol and IPC allowlists, window placement, and deterministic worker lifecycle behavior. A compare-only browser matrix captures empty, long-history, tool-detail, running, success, approval, question, and error states across pairwise viewport, scale, theme, mode, locale, motion, character, and sidebar choices. Its Windows approval fixture preserves the recorded transcript while replacing the POSIX command with an equivalent PowerShell request so it exercises the real approval path. The Windows Electron e2e verifies the single-instance lock, one named Harness utility process, random loopback ports and release, preload isolation, scene/work and narrow layouts, ordinary-browser behavior, missing system voices, external links, rapid crash recovery and recovery actions, placement persistence, screenshots, and graceful zero-code shutdown.

## Alternatives considered

**Tauri.** Tauri would reduce the shell binary size, but the product already embeds a Node-based Cordis plugin graph with native Node dependencies. A Rust host would still need to launch and supervise a separate Node runtime, adding a second toolchain and process protocol without removing the Web UI or Node backend.

**Browser-only skin.** A browser plugin can replace the layout, but it cannot provide a coherent frameless desktop window, single-instance behavior, controlled backend lifecycle, or direct folder commands. It remains useful as the browser-compatible presentation half, not as the complete desktop product.

**Independent frontend fork.** Copying the Web frontend would maximize visual freedom but duplicate session, settings, tool, and plugin integration. The layout-frame extension keeps the same freedom over arrangement while preserving upstream ownership.

**Ordinary Node child process.** A child process could host Harness, but Electron's utility process provides an Electron-owned lifecycle and a structured parent port without enabling Node in the renderer. The utility process is the narrower desktop integration.

## Consequences

The product can change its character art and layout independently while continuing to receive official Harness features. The lasting merge surface is limited to the layout extension, profile-boot API, message-feedback event, settings allowlist, and Electron-compatible Loader fallback. The cost is that these small upstream-facing changes require deliberate merge rehearsals and regression coverage, and the application remains a source-run Windows desktop until a separate packaging decision adds installers, signing, and updates.
