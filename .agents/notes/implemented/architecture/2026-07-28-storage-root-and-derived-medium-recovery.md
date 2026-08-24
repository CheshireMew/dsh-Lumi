# Agent Note: Storage root placement and derived-medium recovery

Status: implemented

English | [中文](2026-07-28-storage-root-and-derived-medium-recovery.zh.md)

## Problem

The persisted projection cache ([note](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md), shipped as `dsh-session-projection-cache`) surfaced two gaps in the storage substrate it landed on. Both are properties of the domain-KV stack ([design](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)), not of the cache itself, and both bite the cache first because it is the first *derived* medium on that stack.

**Where the files live.** The shared base defaults the session store to the global harness home (`$DSH_HOME/sessions`, default `~/.dsh/sessions`), and the shipped Web overlay anchors `storage-json.root` to `$DSH_HOME/storages` with the same `!!js` expression (`apps/cli/config/web.cordis.yml`). `JsonStorageBackend` resolves that configured root once at construction, so a later `process.cwd()` change cannot split one backend across directories. Sessions, workspace records, and projection checkpoints therefore keep one stable home across launch directories.

**How recovery works.** Inside a healthy medium the cache remains self-healing: a `stateVersion`-mismatched row is discarded and refolded, a log shrunk below a row's watermark triggers one full re-read, and background writes are fail-soft. At the medium level, `session_projcache` declares itself disposable. A truncated, hand-edited, version-bumped, or schema-invalid cache unit is removed and reopened once, while the same damage in the authoritative `workspace` and `message_feedback` domains still fails startup. Ordinary I/O and configuration failures also stay loud.

## Decision

Two independent changes, one per gap.

### One global storage root, resolved once at construction

- The Web overlay anchors `storage-json.root` to `$DSH_HOME/storages` directly in the row through the app-boot-provided `dshHomePath('storages')` (`~/.dsh/storages` by default, beside `~/.dsh/sessions`; no leading dot because the home is already a hidden tree). The helper delegates to the canonical `dsh-home-paths` resolver, and the session root uses the same function without duplicating its fallback and tilde rules. Per-row overrides use the personal `~/.dsh/config.yaml` patch layer. The web e2e scaffold patches the row to an absolute temporary root, so tests never touch the user's home.
- `JsonStorageBackend` resolves its configured root once at construction (`resolve(config.root)`). A later `process.cwd()` change cannot split one backend across roots. The SQLite storage backend already resolves its path.
- Pre-release stance applies (and was executed): no migration shim. A deployment that cached under `<cwd>/.storages` re-derives everything (workspace re-bootstraps from the header index; the projection cache refolds lazily) or moves the two json files by hand once.

### Declared derived media: reset instead of reject

- `DomainSpec` gains `recovery?: 'reject' | 'reset'` (default `'reject'`). The spec object is already the single source of a domain's identity and layout; whether its medium is authoritative or derived is the same kind of fact and lives in the same place. `session_projcache` declares `'reset'`; `workspace` stays on the default.
- `KvFacet` gains one primitive: `destroy(descriptor): Promise<void>` — remove the unit's medium entirely (json: delete the file; sqlite: drop the unit's tables). Like `open`, it is a backend storage primitive, not policy.
- `DomainFacility.open`, when a spec declares `'reset'` and the open fails with exactly a damage-class error — `StorageError('version-mismatch' | 'malformed-medium')` or `DomainError('invalid-record')` — logs one warning naming the domain and the discarded medium, calls `destroy`, and opens again empty. Every other failure (`backend-not-found`, `facet-unsupported`, `already-open`, I/O errors) stays loud regardless of the declaration: misconfiguration and environmental faults are not medium damage. The retry is single-shot — a second failure propagates, so a persistently failing medium cannot loop.
- With this in place the cache domain spec's version field gains its intended meaning: bumping `version` (or letting zod reject drifted rows) genuinely discards the whole medium and the cache rebuilds through its normal write points and cold reads — the recovery ladder's outermost rung, matching the row-level rungs already shipped.

## Alternatives considered

**Keep per-launch-directory `.storages` (the pre-change status quo)** — rejected: sessions are global, so every derived-from-sessions medium splits against its own source of truth; the cache's motivating scenario (one listing over all sessions) structurally misses rows, and the workspace registry indexes sessions it cannot see from another launch directory.

**Launcher patch + a `storageRoot` profile key** — not taken: one `!!js` yml expression reaches the global root with the same layering the session root already has; a launcher patch adds a second rewrite point, and the profile key is an empty seat until a real consumer exists (per-row overrides already have the personal config.yaml patch layer).

**Patch only the projection cache's route to a global root, leave `workspace.json` per-cwd** — rejected: the workspace registry has the identical global-vs-cwd mismatch, and the user chose to place the cache beside `workspace.json` — one hub root keeps the media co-located and the mental model single.

**Cache-plugin-local recovery (catch damage errors in `SessionProjectionCache[Service.init]`, delete the file, reopen)** — rejected: the plugin cannot name the medium path without reaching around the backend abstraction, and every future derived domain would re-implement the same catch; the facility is the one place that already classifies open failures.

**Fall back to an ephemeral in-memory domain on damage** — rejected: it silently degrades to memory-only for the life of the process and the damaged file never heals; the next boot fails the same way.

**Rename the damaged medium aside (`<unit>.json.corrupt-<ts>`) instead of deleting** — not chosen: a derived medium's damaged bytes have no recovery value (the logs are the source of truth) and the litter accumulates unbounded; delete is the honest operation. Rename-aside remains the right choice if a future *authoritative* domain ever wants reset semantics — which is exactly why `recovery` is per-spec.

**A blanket auto-reset for every domain (no spec field)** — rejected outright: `workspace.json` is authoritative user data; silently resetting it on a version bump would destroy workspaces. Authority is a property of the domain and must be declared by its owner.

## Verification

- `dsh` launched from any directory reads and writes the same `$DSH_HOME/storages/*.json` (default `~/.dsh/storages`); per-row overrides ride the personal config.yaml patch layer, and the JSON backend's relative-root regression test proves construction-time resolution.
- With a truncated, version-bumped, or schema-drifted `session_projcache.json`, the assembly boots clean: one warning names the discarded medium, the file is gone, the cache rebuilds through normal operation, and the cold listing column reappears as sessions are re-checkpointed.
- The same damage to `workspace.json` still fails boot loudly.
- Facility tests cover every damage class, single-shot retry, non-damage propagation, and the authoritative default. The shared backend contract proves that `destroy` refuses live units, is idempotent for an absent unit, and removes records plus the global value on both shipped backends.

## Consequences

- Derived-domain startup no longer depends on preserving a rebuildable cache file. Recovery can increase the next cold-read cost, but it cannot substitute cached state for the session log.
- Every KV backend implements the same closed-unit `destroy` primitive. Adding a backend now includes the shared destruction conformance case as part of its acceptance path.
- Relative JSON roots have construction-time meaning. Changing `process.cwd()` later affects neither existing units nor units first opened after the change.

## Risks

- **Auto-delete on a misclassified error destroys a healthy file.** Mitigated by the closed damage-class list: reset fires only on the three deterministic parse-time codes; ENOENT is already "empty unit", and every I/O error (EACCES, EIO) propagates loudly. The single-shot retry bounds the blast radius to one delete per open.
- **Root relocation changes where existing checkouts look.** Accepted under the pre-release stance (backends reject old formats, no external consumers); the note above records the one-time manual move for anyone who cares about a per-cwd `workspace.json`'s content.
- **`destroy` is a new destructive primitive on the storage seam.** Its only caller is the facility's declared-reset path; the backend contract documents it as facility-owned, and nothing model-facing or user-facing can reach it.
