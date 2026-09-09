## Context

This change codifies crawler/report hardening behavior introduced across commits from `e32187cf` through `dfc6be34` into durable OpenSpec requirements.

## Scope Mapping

- **Rate and budget control**: adaptive concurrency, slot-claim timing, circuit breaker safety.
- **Sitemap robustness**: robots/sitemap discovery, XSL-safe fetch strategy, image sitemap exclusion, accurate discovered-link accounting.
- **Auth/header safety**: scoped auth propagation, CORS-safe header handling, avoidance of unnecessary global header rewrites.
- **Redirect and URL boundary safety**: normalization and hostname equivalence rules, out-of-scope redirect discard behavior.
- **Custom-flow guard resilience**: loop prevention for `file://` and `about:blank`, overlay continuity in headful macOS/Windows.
- **Report pipeline resilience**: graceful Crawlee storage cleanup, Windows EPERM tolerance, JSONL corruption tolerance, retry-safe error recording.

## Design Decisions

1. **Capability-first decomposition**
   - Separate specs by concern domain to keep requirements testable and independently maintainable.
2. **Normative behavioral language**
   - Use SHALL/MUST to encode invariant behavior that must survive refactors.
3. **Scenario-driven acceptance**
   - Every requirement includes concrete WHEN/THEN scenarios that map directly to tests or regression checks.

## Validation Strategy

- Use `openspec validate --strict` to ensure artifact schema validity.
- Cross-check scenarios against known pitfalls in `AGENTS.md` and crawler/report modules.
- Keep capability boundaries aligned with real module ownership to reduce drift.