# @dsh-lumi/desktop

English | [中文](README.zh.md)

Electron desktop host for Lumi. Electron owns the single-instance window, sandboxed preload bridge, Harness utility-process lifecycle, desktop folders, bounded local diagnostics, signed Windows packaging, and update checks. The official Web app remains the product core and is served from a loopback, operating-system-assigned port by the same profile boot path as the CLI.

The `lumi-desktop` profile is initialized once with `dsh-base`, `dsh-web-app`, and `@dsh-lumi/bundle-desktop`. Existing profile patches, home patches, sessions, settings, credentials, and plugins remain user-owned under the ordinary `$DSH_HOME`.

## Commands

- `pnpm run build` builds only the Electron main, preload, and worker entries after their workspace dependencies exist.
- `pnpm run start` starts existing output.
- `pnpm run test` runs protocol, IPC, window-placement, and deterministic lifecycle tests.
- `pnpm run test:e2e` builds the complete product and launches real Electron. It covers the single-instance lock, one Harness utility process, random ports and release, preload isolation, scene/work and narrow layouts, browser mode without desktop buttons, missing system voices, external links, rapid crash recovery, recovery actions, placement persistence, screenshots, and graceful shutdown.
- `pnpm run dist:windows` builds the signed x64 NSIS installer locally. `forceCodeSigning` makes missing Windows credentials a hard failure; this command is not part of ordinary development checks.
- `pnpm run publish:windows` is the release-workflow entry. It accepts only the version-matched `lumi-v*` tag and stages the installer, blockmap, and update metadata in a draft GitHub release.

## Operating boundary

- Only the current Windows platform is accepted locally.
- Release packaging requires `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` in the protected `lumi-desktop-release` GitHub environment. Installed update checks require users to be able to read the repository's published release assets.
- The preload API opens folders through the operating system but does not include an in-app file manager.
