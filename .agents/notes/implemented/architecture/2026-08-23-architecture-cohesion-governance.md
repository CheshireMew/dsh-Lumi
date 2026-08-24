# Agent Note: Architecture cohesion governance

Status: implemented

English | [中文](2026-08-23-architecture-cohesion-governance.zh.md)

## Problem

Several central modules accumulated unrelated policies, protocol declarations, state transitions, and rendering in one implementation. The Host API implementation also owned the browser protocol used by its own transport consumers, which created a production dependency cycle. Client tests copied a full API double, product versions and visual colors had multiple owners, and configurable limits were embedded in runtime methods. These patterns made a local change affect distant packages and gave the repository no automatic signal when the same concentration returned.

## Decision

The legacy browser protocol lives in `@deepseek-ai/dsh-api-protocol`, below both `dsh-client-connection` and `dsh-host-apiproxy`. The Host package implements that protocol without owning it. Client packages share `@deepseek-ai/dsh-client-api-testkit` instead of copying protocol doubles. Public product name, version, repository identity, protocol token, and HTTP user agent come from `@deepseek-ai/dsh-product-identity`.

`createApiProxy` is an assembly function. Session runtime, reading, listing, summaries, interactions, event streaming, and each API domain have separate modules. Deployment-varying search, cold-read, cursor-retention, and export choices enter through `ApiProxyDefaults`; registered settings namespaces declare `configuration-client` exposure at their owner instead of appearing in a gateway list.

Typert analysis separates declaration-graph construction, Remote call modeling, Remote codec modeling, and workspace/export coordination. The trajectory table separates its fold model, state hook, ledger, inspector, record content, and inspector content. Directory browsing and the conversation input bar separate state and command handling from rendering. Workspace browsing keeps ordering and list-section policies outside its assembly view.

Client color values are declared by `ui-theme` tokens. Components consume semantic or static tokens, including illustration fills and syntax colors, rather than owning RGB or hexadecimal values. Protocol-defined ANSI colors remain the one runtime conversion exception.

## Enforced limits

`verify-architecture-governance` rejects production package cycles, a new source file above 1,000 lines, growth beyond the documented ceilings of existing cohesive or generated/data-heavy modules, regression of the six repaired symbols, a production `0.0.1` literal, and a client color literal outside `ui-theme`. Generated catalogs and test-support source are outside the ordinary source-size rule; explicitly listed cohesive modules retain named ceilings and reasons. The gate runs in shared CI static checks and repository hygiene. Cross-file clone detection and the client-domain import gate remain separate checks because they answer different questions.

## Alternatives considered

- **Keep the Host package as the protocol owner and break the cycle with type-only imports** — rejected because runtime schemas and carrier adapters are values, and ownership would still point from a lower transport layer to a higher implementation layer.
- **Split files only by size** — rejected because equally mixed smaller files retain the same coupling. Extracted modules own stable responsibilities and the assembly files depend on those responsibilities.
- **Make every source file obey one small limit immediately** — rejected because generated catalogs, deterministic fixture data, and cohesive state machines would become arbitrary fragments. The general ceiling applies to new code, while current exceptions state both a bounded ceiling and an ownership reason.
- **Allow component-local color literals** — rejected because a local literal silently opts out of theme changes. Theme tokens provide one reviewable owner without forcing every visual constant to be theme-adaptive.

## Consequences

The package graph is acyclic on production dependency edges, and browser-safe protocol consumers no longer load Host implementation ownership. Large implementations have smaller review and test surfaces, but their assembly modules now import more named collaborators. The structural gate deliberately preserves a short exception inventory; adding or raising an exception is an architectural decision visible in code review. New visual constants require a theme token, including constants that remain identical across light and dark themes.

## Verification

The governance script has unit coverage for cycle detection, comment-insensitive color detection, and declaration measurement. Its repository run checks the real package graph, file and symbol budgets, product-version ownership, and client sources. The repository duplication check reports no production clone. Focused typechecks and behavior suites cover ApiProxy, Typert generation, trajectory rendering, directory browsing, composer input, and workspace browsing.
