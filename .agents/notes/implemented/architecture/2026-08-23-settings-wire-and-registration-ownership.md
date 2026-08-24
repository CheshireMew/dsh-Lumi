# Agent Note: Settings wire and registration ownership

Status: implemented

English | [中文](2026-08-23-settings-wire-and-registration-ownership.zh.md)

## Problem

The settings service had three ownership gaps. A protocol caller had to remember `describe({ redactSecrets: true })`, while the redactor returned values behind unions, intersections, and transforms without proving that no secret was reachable; the serialized schema and write-rejection text could also contain secret literals. A namespace disposer removed its registration without waiting for an already-started watcher, so plugin teardown could finish while the plugin's callback still ran. Finally, a write already inside `persist()` could finish after the old registrant disposed and a replacement registered, leaving the replacement resolved from the pre-write document. Property construction with `{}` also failed to preserve `__proto__` as ordinary JSON data.

## Decision

`SettingsProvider.describe()` is the verbatim same-process surface. `describeForWire()` is the only client descriptor surface and has no opt-in switch: it keeps schema-proven JSON fields, selects the validating union branch, combines intersection fields, and treats transforms or unknown nodes as opaque write-only slots. It strips every declared secret from resolved, base, and user layers; `schemaForWire()` replaces secret or opaque schema nodes and removes secret defaults. ApiProxy uses this method exclusively and maps non-conflict write failures to a stable value-free message. Schemas whose open-ended data can carry credentials declare that container secret; pi-ai therefore marks its entire `headers` map write-only.

A registration now owns its watcher settlement. Its disposer marks the registration and every watcher inactive, removes the namespace only if it is still the owner, and waits for already-started callback tails. A surviving scope cannot add a watcher after disposal. Writes still reach storage once `persist()` has begun. After persistence, the service resolves whichever registration currently owns the namespace from the committed raw section; an old registration receives nothing, while a replacement advances its revision and receives the committed value. Provider publications advance the raw revision before attempting resolved-value validation, including schema-invalid object sections.

Settings record construction uses own-property definition and property-safe clones for patches, nested path edits, and layered merges. Keys such as `__proto__` remain data and never invoke an inherited setter. Deep equality requires matching own properties rather than accepting a prototype property as a match.

## Alternatives considered

- **Keep the redaction boolean and audit every carrier** — rejected because the safe result would continue to depend on every future wire caller remembering an option.
- **Reject every namespace containing a transform** — safe but unnecessarily removes the rest of a usable settings form. Making only that field opaque preserves the proven fields and exposes its configured state without its value.
- **Cancel a persist when its owner disposes** — impossible once a provider has crossed its durability point, and cancellation could leave process state disagreeing with storage. The current owner is resynchronized after the write instead.
- **Let registrant disposal detach running callbacks** — rejected because the callback belongs to registrant code and may still touch resources that the same fiber is releasing.

## Consequences

Wire configuration views can be less detailed than same-process views: an opaque field is write-only even when some instances would contain no credential. Rejected write responses no longer repeat detailed schema or provider diagnostics; those remain Host-local. Registrant disposal can wait for a slow callback, which makes resource ownership deterministic. A replacement registration observes an older write that reached durability after the replacement appeared, matching the provider document rather than registration timing.

## Verification

The settings suite covers secret-bearing union and intersection values, opaque transforms, secret schema defaults, property-safe `__proto__` writes, registrant watcher drain, and registration replacement during delayed persistence. ApiProxy tests prove response bodies omit rejected secret input and sanitized schema defaults. The pi-ai dynamic-settings test proves arbitrary provider headers stay available to the adapter while the wire receives only the write-only slot state.

## Risks

- An opaque field cannot be edited structurally by a generic form; the client must replace that field as one value. This is the required cost when the schema output relation cannot be proven.
- A watcher that never settles now prevents its owning plugin from disposing. Watcher callbacks already had a completion contract; the new behavior makes that ownership visible instead of allowing teardown to complete incorrectly.
