# Agent Note: Downstream DSH patch governance

Status: implemented

English | [中文](2026-08-24-downstream-dsh-patch-governance.zh.md)

## Problem

Lumi prefers additive plugins and bundle patches, but some official DSH defects and missing extension points must be corrected in this fork because upstream does not accept the required changes. Ordinary source edits hide that maintenance obligation. The existing upstream sync list monitored only a few historically contentious files, while the fork already contained both intentional DSH changes and unrelated worktree changes that could not be safely reverted or assigned to one feature from path names alone.

## Decision

Every path present in `upstream-base` is upstream-owned. A new `@deepseek-ai/dsh-*` package is also a downstream DSH change even when its files do not exist upstream. Lumi-only behavior continues to prefer `@dsh-lumi/*` plugins, bundles, adapters, and profile patches.

`.upstream-patches.json` separates active semantic patches from a frozen legacy baseline. An active patch records a stable id, reason, owned exact paths or explicit recursive directories, focused validation, retirement condition, reviewed official commit, and last review outcome. The initial legacy baseline stores exact content hashes for pre-policy differences not safely attributable during adoption. It preserves those files without treating them as understood: changing one fails the gate until the path is promoted to an active patch or explicitly re-frozen after review. Vendored Cordis remains under `vendor/README.md` and never enters this manifest.

`verify-upstream-patches` compares the current committed and worktree state with `upstream-base`. It rejects unregistered upstream-owned differences, changed or stale legacy entries, invalid patch records, and an active patch touched by official changes after its recorded review commit. The upstream synchronization report names every active patch touched by the incoming official range. Validation stays red until the patch records one reviewed outcome: retain, reapply, refactor onto a new seam, or retire.

## Alternatives considered

- **Revert every upstream-owned difference during adoption** — rejected because the dirty worktree contains accepted Lumi foundations, DSH corrections, and unrelated in-progress work that cannot be destructively attributed from paths alone.
- **Rely only on Git conflicts and `rerere`** — rejected because an automatic textual merge can preserve invalid downstream behavior without producing a conflict.
- **Require an accepted upstream PR for every correction** — rejected because upstream acceptance is outside this fork's control and is not available for the changes the product requires.
- **Extend only `.upstream.json.highConflictFiles`** — rejected because a flat watch list carries no reason, validation, retirement condition, review commit, or exact frozen state for unclassified differences.

## Consequences

The fork may retain necessary DSH fixes without pretending they are ordinary Lumi code or depending on upstream PR acceptance. Existing unclassified work is preserved rather than destructively reverted, but its hash freeze prevents silent expansion. Whole-package selectors are reserved for patches that genuinely own that package-level responsibility; repository instructions prohibit mixing formatting, unrelated refactors, or Lumi-only behavior into them.

The required ownership rule was condensed to its executable constraints. Because the existing root instructions already occupied 1,885 of their 1,900 words, the documented ceiling increases to 2,000 rather than removing unrelated project rules.

An upstream merge can still require source-level judgment. The manifest does not automate conflict resolution; it makes the affected local decision, validation, and retirement condition visible before a new official base can be accepted.

## Verification

The verifier has unit coverage for exact and recursive ownership plus touched-patch reporting. It runs in shared CI static checks, repository hygiene, and the protected upstream synchronization checks. The current adoption records seven active patches and freezes all other current governed differences by content hash.
