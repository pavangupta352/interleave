# Project working agreement

Read `PRODUCT.md`, `docs/architecture/specification.md` and `docs/plans/implementation.md` before changing behavior. If `.local/CURRENT.md` exists, read it first and use its ledger to resume completed work without repeating it. Update the continuation record after milestones and before context transitions.

Run actual application queries against real PostgreSQL. Keep protocol bytes intact. Distinguish query release from completion and record actual lock observations. Never label timeouts or unsupported behavior as passing evidence.

Use tests that catch real behavioral regressions. Run the relevant unit and real-database suites, then the required release matrix. Keep source/version identities and unrun qualification gates explicit. Preserve other projects and existing databases.

Use the Impeccable skill before user-facing UI work. Keep reports keyboard-accessible, offline-capable and grounded in actual artifacts.

Use repository-local author identity Pavan Gupta <pavan.gupta.352@gmail.com>. Preserve third-party licensing. Avoid irrelevant contributor trailers, unsupported performance claims, novelty assertions, fabricated adoption or testimonials.
