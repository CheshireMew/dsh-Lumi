# Anime desktop

English | [中文](anime-desktop.zh.md)

The anime desktop app presents the official DeepSeek Harness Web UI inside Electron. It keeps the official sidebar, conversation, tools, approvals, questions, settings, workspaces, plugins, details, and session storage. Electron manages only the native window and the local Harness process, while the anime packages replace the root arrangement and add local character behavior.

## Install and run from source

The current acceptance platform is Windows 10 or 11. Use a repository-supported Node.js release and pnpm, and keep the Electron and pnpm caches outside the system drive when required:

```powershell
$env:ELECTRON_CACHE = 'D:\Tools\electron-cache'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
pnpm install --store-dir 'D:\Tools\pnpm-store'
pnpm run build:anime
pnpm run start:anime
```

`pnpm run dev:anime` starts the Web, anime package, and Electron watches and restarts Electron after desktop-host output changes. `pnpm run compat:anime` checks the upstream-facing profile, layout, character, and desktop interfaces. `pnpm run test:anime` adds the real Electron test. `pnpm run sync:upstream` performs the guarded official merge workflow described in [Anime desktop architecture](../../anime-desktop-architecture.md#upstream-synchronization).

## Shared data and the product profile

The desktop and CLI resolve the same `$DSH_HOME`; when the variable is absent, both use `~/.dsh`. The desktop initializes the `anime-desktop` profile with `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `@dsh-anime/bundle-desktop` only when that profile is absent. Sessions, model configuration, credentials, workspaces, plugins, and settings therefore remain visible to both interfaces. Desktop logs live under `$DSH_HOME/logs/anime-desktop`, character packs live under `$DSH_HOME/anime/packs`, and Electron window placement lives in Electron `userData`.

Do not run two independent persistent Web Hosts against the same `$DSH_HOME`. Electron enforces one application instance, and a second launch restores and focuses the existing window. A browser may open the already-running Anime Host URL because that does not create another Host.

## Interface, speech, and bond progress

Scene mode keeps the character prominent and places the official conversation in a bottom glass panel. Work mode expands the conversation and moves the character behind the working area at low opacity. Widths below 1100 pixels use the work arrangement and hide the character; the 1100–1439 range uses tighter spacing, and widths from 1440 pixels use the complete scene arrangement. Motion can follow the operating system or be forced to full or reduced behavior.

Text-to-speech uses Chromium's access to installed system voices. It is off by default and never uploads or saves audio. Automatic reading applies only to a newly completed final assistant message in the visible session; opening history, refreshing, reconnecting, or switching sessions does not replay old messages. Speech removes code blocks, raw URLs, tables, image targets, Markdown structure, reasoning, and tool content. Automatic reading stops at a natural sentence boundary near its configured limit, while manual reading can speak the complete cleaned message. Hiding the window, switching sessions, starting a new automatic read, or pressing Stop cancels the current utterance. If the operating system has no voice, speech controls are disabled and chat continues normally.

Bond progress is stored only in the `ui-anime` settings namespace. It never enters the Session log, model prompt, context, or model selection. Each error-free completed turn earns 2 points for the first 10 awarded turns of a local calendar day, the first successful turn of the day earns 3 additional points, and the first positive message rating of the day earns 5 points. Completed-turn and feedback identities are stored so refreshes and reconnects cannot award them twice. Consecutive natural-day use increases the streak; a gap resets only the streak, and negative feedback never removes points. The level is `floor(points / 30) + 1`; packs may use it only to unlock local expressions, idle actions, and bubbles.

## Character Pack v1

Open the pack folder from the desktop title bar or create `$DSH_HOME/anime/packs/<pack-id>`. The fixed directory structure is:

```text
<pack-id>/
  manifest.json
  preview.webp
  background.webp
  layers/
  expressions/
  effects/
```

Every manifest uses `schemaVersion: 1`. The directory name and `id` must match, `id` may contain lowercase letters, digits, dots, underscores, or hyphens and has at most 64 characters, and every declared asset must be a relative path inside its required directory. `preview` and `background` are fixed to `preview.webp` and `background.webp`. SVG, PNG, WebP, and JPEG files are accepted. Missing files, absolute paths, backslashes, `.` or `..` segments, invalid state references, unsupported formats, duplicate ids, and incomplete manifests are rejected without breaking the built-in Lumi fallback.

The following abbreviated values show the complete field structure; all eight states are required and each state needs its own animation object:

```json
{
  "schemaVersion": 1,
  "id": "luna",
  "displayName": "Luna",
  "author": "Your name",
  "license": "CC-BY-4.0",
  "version": "1.0.0",
  "canvas": {
    "width": 720,
    "height": 1120,
    "anchor": { "x": 360, "y": 1080 },
    "safeMargin": { "top": 24, "right": 24, "bottom": 24, "left": 24 }
  },
  "assets": {
    "preview": "preview.webp",
    "background": "background.webp",
    "body": "layers/body.svg",
    "expressions": { "neutral": "expressions/neutral.svg", "happy": "expressions/happy.svg" },
    "mouth": { "closed": "layers/mouth-closed.svg", "open": "layers/mouth-open.svg" },
    "effects": { "sparkle": "effects/sparkle.svg" }
  },
  "states": {
    "idle": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 2400 } },
    "listening": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "thinking": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "alternate", "minDurationMs": 1200 } },
    "tool": { "expression": "neutral", "fallback": "thinking", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "waiting": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "success": { "expression": "happy", "effect": "sparkle", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "none", "minDurationMs": 2200 } },
    "error": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "speaking": { "expression": "happy", "fallback": "idle", "animation": { "keyframes": [{ "at": 0, "mouth": "closed" }, { "at": 1, "mouth": "open" }], "loop": "alternate", "minDurationMs": 500 } }
  },
  "idleActions": {
    "breathe": { "animation": { "keyframes": [{ "at": 0 }, { "at": 1, "translateY": -3 }], "loop": "alternate", "minDurationMs": 2400 } }
  },
  "bondUnlocks": [
    { "level": 1, "expressions": ["neutral"], "idleActions": ["breathe"], "bubbles": { "zh": ["你好。"], "en": ["Hello."] } }
  ]
}
```

Animation keyframes start at `at: 0`, end at `at: 1`, and use `loop` values `none`, `repeat`, or `alternate`. Optional keyframe values are `translateX`, `translateY`, `scale`, `rotate`, `opacity`, and `mouth`. State fallbacks must name one of `idle`, `listening`, `thinking`, `tool`, `waiting`, `success`, `error`, or `speaking`. Unlock levels must increase and may reference only declared expressions and idle actions. A missing `license` keeps a valid pack available locally but marks it ineligible for future publication.

The Host watches the pack directory and sends a refresh event to connected clients. A selected pack that disappears or becomes invalid falls back to Lumi and produces a non-blocking notice.

## Recover from failures

The startup page waits up to 30 seconds for Harness. A worker that exits unexpectedly is retried twice; rapid repeated exits then show a recovery page with Retry, Copy diagnostics, and Open logs. Application shutdown sends a structured shutdown request and waits eight seconds before terminating an unresponsive worker. Use the title-bar Logs command to open `$DSH_HOME/logs/anime-desktop`: `main-YYYY-MM-DD.log` records Electron lifecycle events and `harness-YYYY-MM-DD.log` records worker output. The Web server always binds to `127.0.0.1` on an operating-system-assigned port.

For a Windows acceptance run, select a workspace, create a session, send a prompt, observe streaming and a tool call, handle an approval or question, play speech, switch both layout modes, restart the application, and confirm that the same session returns. Real-model steps require a configured provider credential.

## Distribution boundary

The repository pins Electron `43.4.0` but does not contain an installer, packaged executable, signing, an updater, or a release pipeline. The built-in layered Lumi art is an original protocol-complete placeholder, not final character-art acceptance.
