# Lumi desktop architecture

English | [中文](lumi-desktop-architecture.zh.md)

The desktop product is an additive distribution of DeepSeek Harness. It keeps upstream session, plugin, model, tool, settings, and Web UI ownership intact; Electron owns native window concerns, and `@dsh-lumi/*` packages own presentation and character behavior.

## Ownership

| Owner | Responsibilities | Must not own |
|---|---|---|
| Official Harness packages | Sessions, profiles, plugins, tools, settings, Web transport, and every existing business surface | Electron lifecycle or Lumi presentation |
| `@dsh-lumi/bundle-desktop` | The two lumi plugin rows layered after `dsh-base` and `dsh-web-app` | Copies of official bundle rows |
| `@dsh-lumi/client-shell` | Scene/work arrangement of official layout seats | Conversation, sidebar, details, or overlay state |
| `@dsh-lumi/client-character` | Character packs, state projection, speech, bond progress, and its settings/actions | Session persistence or model-visible prompts |
| `@dsh-lumi/desktop` | Single-instance window, preload API, Harness utility process, folders, and logs | Direct access from Web components to Node or Electron |

The official `LayoutRoot` owns the layout store and declares `layout.frame`, sidebar, conversation, details, and overlay slots. The official `AppFrame` occupies `layout.frame` at priority `0`; the Lumi shell occupies it at priority `-100`. Unloading the Lumi shell restores the official frame without remounting or transferring business state.

## Process and startup model

Electron's main process acquires the single-instance lock, creates a frameless sandboxed `BrowserWindow`, and shows a local loading document. A dedicated utility process calls the same profile boot API as the CLI with this bundle order:

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@dsh-lumi/bundle-desktop
```

The worker initializes the `lumi-desktop` profile under the ordinary Harness home, starts the official Web server on `127.0.0.1:0`, and posts structured `starting`, `ready`, `log`, `fatal`, and `stopped` events. The main process accepts only a matching loopback URL and navigates the window after readiness. Startup has a 30-second deadline. Unexpected exits retry twice; ten seconds of stable operation resets the retry budget, while rapid repeated exits show the recovery page. Shutdown and restart send structured commands and wait eight seconds before terminating a worker that cannot settle.

The sandboxed preload exposes only window controls, window-state observation, Harness restart, and commands that open the log or character-pack folders. Context isolation remains enabled and Node integration remains disabled. These choices follow Electron's [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge), [utility process](https://www.electronjs.org/docs/latest/api/utility-process), and [custom window](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) APIs.

## Persistent data

The desktop and CLI resolve the same `$DSH_HOME`. The desktop app adds `$DSH_HOME/lumi/packs`, `$DSH_HOME/logs/lumi-desktop`, and `$DSH_HOME/crashes/lumi-desktop`; it does not copy sessions, profiles, credentials, or settings. The product profile is initialized from the three bundles only when absent, so user-owned profile and home patch files remain authoritative after first creation. Electron window placement uses durable atomic replacement under Electron `userData`. Local text logs and Crashpad dumps have explicit count, size, and age retention. Lumi preferences, speech configuration, unbounded bond points, the daily award ledger, and the bounded feedback-identity window use one versioned Host-authoritative `ui-lumi.bond` record and never enter the Session log or model context.

## Character and browser model

The Host validates Character Pack v1 manifests and referenced assets under `$DSH_HOME/lumi/packs/<pack-id>`, builds renderer-safe same-origin URLs, serves only allowlisted files, and publishes filesystem invalidation through server-sent events. All eight character states, animation timing, fallback references, canvas placement, mouth layers, and bond unlock references are checked at the durable JSON boundary. Invalid selected packs fall back to the protocol-complete built-in Lumi layers. A missing license permits local use but makes a pack non-publishable.

The browser runtime derives character state from the active conversation projection. Waiting and error preempt speech, speech preempts tool and thinking state, tool release is delayed briefly, and success uses the active pack's duration. Session switches seed the completed-turn watermark from visible history without success or speech replay. Character-pack response validation, speech text cleanup, speech playback resources, bond transitions, and orchestration live in separate modules. The local bond ledger consumes only later completed-turn count deltas and the post-mutation `message-feedback/change` event without adding session events; legacy fields migrate in one atomic settings mutation.

<a id="upstream-synchronization"></a>

## Upstream synchronization

`.upstream.json` records the official repository, branch, last validated commit, and files that deserve manual review. The `upstream` remote fetches the official repository and has its push URL disabled locally. Add an `origin` remote only for a personal fork.

The protected update path is:

```powershell
pnpm run upstream:status
pnpm run sync:upstream
```

`upstream:status` is read-only. `sync:upstream` refuses a dirty worktree, fetches official commits and tags, fast-forwards `upstream-base`, returns to `main`, creates `codex/sync-YYYYMMDD-<sha>`, and merges `upstream-base`. A conflict or failed check leaves the synchronization branch and working state intact. After committing a repair on that exact branch, running the command again resumes it even when the local date has changed; an existing branch cannot be resumed from anywhere else. A successful merge runs Lumi contracts and build, official GUI and Web replay, the repository checks, and the built Electron test. The script always writes `docs/upstream-sync/<date>.md` with one trailing newline; only a completely successful run updates `.upstream.json` and `UPSTREAM_BASE.md`. Git `rerere` is enabled so repeated resolutions can be reused.

Resolve source files from upstream intent first, then reapply the small product extension. Do not copy official bundle rows into the Lumi bundle. Regenerate `pnpm-lock.yaml` with `pnpm install` instead of hand-merging dependency records when the lockfile conflict cannot be resolved mechanically. The report identifies official commits, monitored seams changed upstream, automated results, and the remaining manual Web, Lumi, and real-model checks.

## Release boundary

The private npm workspace remains outside the npm release family. electron-builder owns an x64 assisted NSIS target, stable application id, Lumi icon, ASAR payload, update metadata, and a GitHub draft provider. Production packaging has `forceCodeSigning` and Windows update-signature verification enabled. The protected workflow separates read-only source/configuration verification from the only write-capable job, checks the exact `lumi-v<version>` tag, requires Windows signing secrets, and publishes the exact installer bytes plus blockmap and `latest.yml` to a draft release. End-user update delivery additionally requires repository release assets those users can read; changing repository visibility remains an explicit publication decision.
