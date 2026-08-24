# Agent Note: Recoverable desktop user operations

Status: implemented

English | [中文](2026-08-24-recoverable-desktop-user-operations.zh.md)

## Problem

Several desktop actions crossed a browser, Host, filesystem, or provider boundary without carrying failure back to the person who initiated them. Startup failure could leave a frameless window without recovery controls, Workspace navigation and sidebar actions could fail only in the console, settings could appear saved before durable state agreed, DeepSeek credentials could be persisted without testing the typed key, and character-pack setup exposed a folder instead of an installation flow. Modal and menu primitives also left keyboard focus behavior to individual consumers. These gaps made a rejection look like an ignored click or a successful change.

## Decision

The desktop shell owns a localized recovery state before the web client is available. Its loading and failure page keeps the same draggable title bar and minimize, maximize, and close controls as the main window; a startup failure offers retry, diagnostic copy, and log-folder actions. The web root uses the same recovery posture for client boot failures, retaining a human-readable summary while keeping technical details available on demand.

The component that starts a reversible user operation retains its pending or failed state until the authoritative owner confirms success or the user retries. Lumi preference writes compare the resulting settings snapshot and restore the previous value on rejection. Pack catalog loading distinguishes loading, stale fallback, read-only state, rejected directories, and retry. Narrow windows disable scene mode with an explanation instead of leaving a control that cannot produce its advertised result.

`WorkspaceRuntime` projects connection failures separately from the Workspace baseline and returns a settled success result from `startSession`, so a shell callback cannot create an unhandled rejection. The conversation shell and Workspace browser show the retained raw reason and retry the same Workspace. The browser also coordinates fork, archive, restore, and durable reorder operations; overlapping failures remain queued for individual retry or dismissal. A real-Workspace Session drag changes the browser order only after Host acceptance, while rejection keeps both the former order and an exact retry.

The shared `Modal` and `Menu` primitives own focus entry, ordered keyboard movement, Escape behavior, nested-surface precedence, background inertness, and focus restoration. Consumers supply labels and initial-focus intent instead of recreating document-level keyboard handlers.

The Lumi desktop bundle registers authenticated model discovery for the official DeepSeek settings namespace. Desktop DeepSeek credential submission sends the unsaved key to the configured `/models` endpoint and performs no settings or credential write unless that request succeeds. A browser deployment without the Lumi desktop bundle keeps the ordinary provider-save path because it has no desktop-specific discovery owner.

Character-pack import performs preflight inspection, copies into a staging directory, validates the staged copy, and installs it with one rename. It never overwrites an installed pack. Failed staging data is retained for diagnosis, while cancellation and validation failures leave the installed catalog unchanged. The settings panel shows manifest identity, author, version, license, catalog diagnostics, import progress, and the final outcome rather than treating the pack root as the user workflow.

## Alternatives considered

**Keep failures in logs and the developer console.** Rejected because the person who initiated the action cannot tell whether it is pending, rejected, or safe to retry, and the startup page may be the only available interface.

**Implement focus and Escape handling in each dialog and menu.** Rejected because nested overlays need one ordering rule and one focus-restoration owner; independent document listeners can close the wrong surface or return focus to an inert element.

**Save credentials first and verify them through a later model request.** Rejected because a failed probe would leave an unusable secret and provider profile persisted, turning validation into cleanup work.

**Let users copy packs directly into the live catalog.** Rejected because partial copies and invalid manifests become live state. Staging keeps the installed catalog unchanged until the complete pack has passed the same reader used at runtime.

## Verification

Focused browser and Host tests cover recovery rendering, keyboard behavior, visible Workspace navigation and action retries, Host-confirmed reordering, preference rollback, catalog fallback, pack import atomicity, and pre-persistence credential verification. The Windows desktop E2E launches the assembled application, exercises window controls and narrow layout, terminates the Harness, operates the localized failure page, restarts the Harness, and confirms that the main client returns.

## Consequences

Desktop failures consume more explicit UI state and DeepSeek credential saves require one bounded network request, but rejected operations remain understandable and recoverable without inspecting a console. Workspace reordering now waits for Host acceptance before changing the saved browser order, so a slow request leaves the prior order visible instead of presenting an unconfirmed result. Pack upgrades require a distinct future policy because import deliberately refuses overwrite. The browser build remains usable without desktop-only APIs, and external provider availability is still a runtime condition rather than a release guarantee.
