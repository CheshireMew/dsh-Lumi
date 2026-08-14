# Anime desktop architecture

English | [中文](anime-desktop-architecture.zh.md)

The desktop product is an additive distribution of DeepSeek Harness. It keeps upstream session, plugin, model, tool, settings, and Web UI ownership intact; Electron owns native window concerns, and `@dsh-anime/*` packages own presentation and character behavior.

## Ownership

| Owner | Responsibilities | Must not own |
|---|---|---|
| Official Harness packages | Sessions, profiles, plugins, tools, settings, Web transport, and every existing business surface | Electron lifecycle or anime presentation |
| `@dsh-anime/bundle-desktop` | The two anime plugin rows layered after `dsh-base` and `dsh-web-app` | Copies of official bundle rows |
| `@dsh-anime/client-shell` | Scene/work arrangement of official layout seats | Conversation, sidebar, details, or overlay state |
| `@dsh-anime/client-character` | Character packs, state projection, speech, bond progress, and its settings/actions | Session persistence or model-visible prompts |
| `@dsh-anime/desktop` | Single-instance window, preload API, Harness utility process, folders, and logs | Direct access from Web components to Node or Electron |

The official `LayoutRoot` owns the layout store and declares `layout.frame`, sidebar, conversation, details, and overlay slots. The official `AppFrame` occupies `layout.frame` at priority `0`; the anime shell occupies it at priority `-100`. Unloading the anime shell restores the official frame without remounting or transferring business state.

## Process and startup model

Electron's main process acquires the single-instance lock, creates a frameless sandboxed `BrowserWindow`, and shows a local loading document. A dedicated utility process calls the same profile boot API as the CLI with this bundle order:

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@dsh-anime/bundle-desktop
```

The worker initializes the `anime-desktop` profile under the ordinary Harness home, starts the official Web server on `127.0.0.1:0`, and posts structured `starting`, `ready`, `log`, `fatal`, and `stopped` events. The main process accepts only a matching loopback URL and navigates the window after readiness. Startup has a 30-second deadline. Unexpected exits retry twice; ten seconds of stable operation resets the retry budget, while rapid repeated exits show the recovery page. Shutdown and restart send structured commands and wait eight seconds before terminating a worker that cannot settle.

The sandboxed preload exposes only window controls, window-state observation, Harness restart, and commands that open the log or character-pack folders. Context isolation remains enabled and Node integration remains disabled. These choices follow Electron's [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge), [utility process](https://www.electronjs.org/docs/latest/api/utility-process), and [custom window](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) APIs.

## Persistent data

The desktop and CLI resolve the same `$DSH_HOME`. The desktop app adds only `$DSH_HOME/anime/packs` and `$DSH_HOME/logs/anime-desktop`; it does not copy sessions, profiles, credentials, or settings. The product profile is initialized from the three bundles only when absent, so user-owned profile and home patch files remain authoritative after first creation. Electron window placement is validated and atomically stored under Electron `userData`. Anime preferences, speech configuration, unbounded bond points, daily award ledgers, and credited identities use the Host-authoritative `ui-anime` settings namespace and never enter the Session log or model context.

## Character and browser model

The Host validates Character Pack v1 manifests and referenced assets under `$DSH_HOME/anime/packs/<pack-id>`, builds renderer-safe same-origin URLs, serves only allowlisted files, and publishes filesystem invalidation through server-sent events. All eight character states, animation timing, fallback references, canvas placement, mouth layers, and bond unlock references are checked at the durable JSON boundary. Invalid selected packs fall back to the protocol-complete built-in Lumi layers. A missing license permits local use but makes a pack non-publishable.

The browser runtime derives character state from the active conversation projection. Waiting and error preempt speech, speech preempts tool and thinking state, tool release is delayed briefly, and success uses the active pack's duration. Session switches reseed visible history without success or speech replay. Chromium speech synthesis reads only cleaned final assistant text; utterance lifecycle and boundary events drive speaking state and the mouth layer. The local bond ledger consumes new successful turns and the post-mutation `message-feedback/change` event without adding session events.

## Upstream synchronization

`.upstream.json` records the official repository, branch, last validated commit, and files that deserve manual review. The `upstream` remote fetches the official repository and has its push URL disabled locally. Add an `origin` remote only for a personal fork.

The protected update path is:

```powershell
pnpm run upstream:status
pnpm run sync:upstream
```

`upstream:status` is read-only. `sync:upstream` refuses a dirty worktree, fetches official commits and tags, fast-forwards `upstream-base`, returns to `main`, creates `codex/sync-YYYYMMDD-<sha>`, and merges `upstream-base`. A conflict leaves the branch and merge state intact. A successful merge runs Anime contracts and build, official GUI and Web replay, the repository checks, and the built Electron test. The script always writes `docs/upstream-sync/<date>.md`; only a completely successful run updates `.upstream.json` and `UPSTREAM_BASE.md`. Git `rerere` is enabled so repeated resolutions can be reused.

Resolve source files from upstream intent first, then reapply the small product extension. Do not copy official bundle rows into the anime bundle. Regenerate `pnpm-lock.yaml` with `pnpm install` instead of hand-merging dependency records when the lockfile conflict cannot be resolved mechanically. The report identifies official commits, monitored seams changed upstream, automated results, and the remaining manual Web, Anime, and real-model checks.

## Release boundary

The repository pins one Electron version and verifies it on Windows. It contains no installer, application packaging, code signing, automatic updater, or release channel. Those concerns remain outside the desktop runtime until a packaging task explicitly introduces them.
