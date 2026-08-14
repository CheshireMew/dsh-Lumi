# @dsh-anime/desktop

English | [中文](README.zh.md)

Electron desktop host for the anime presentation layer. Electron owns only the single-instance window, sandboxed preload bridge, Harness utility-process lifecycle, desktop folders, and daily logs. The official Web app remains the product core and is served from a loopback, operating-system-assigned port by the same profile boot path as the CLI.

The `anime-desktop` profile is initialized once with `dsh-base`, `dsh-web-app`, and `@dsh-anime/bundle-desktop`. Existing profile patches, home patches, sessions, settings, credentials, and plugins remain user-owned under the ordinary `$DSH_HOME`.

## Commands

- `pnpm run build` builds only the Electron main, preload, and worker entries after their workspace dependencies exist.
- `pnpm run start` starts existing output.
- `pnpm run test` runs protocol, IPC, window-placement, and deterministic lifecycle tests.
- `pnpm run test:e2e` builds the complete product and launches real Electron. It covers the single-instance lock, one Harness utility process, random ports and release, preload isolation, scene/work and narrow layouts, browser mode without desktop buttons, missing system voices, external links, rapid crash recovery, recovery actions, placement persistence, screenshots, and graceful shutdown.

## Known Limitations and Deferred Work

- The app has no installer, packaged executable, signing, updater, or release channel.
- Only the current Windows platform is accepted locally.
- The preload API opens folders through the operating system but does not include an in-app file manager.
