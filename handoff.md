# Zaoshi source handoff — 2026-10-30

This repository contains the complete sanitized application source at its root. It replaces the older frontend-only mock workspace. Its Git parent is the existing public repository history; private development history was never imported. Existing public commit metadata remains unchanged; privacy sanitation applies to this snapshot and its new commit.

## Snapshot and deployment boundary

The latest local work adds referral rewards (8% cash accrual, 5% bonus package credits), three account/consumer concurrency slots, pending cap 4, no daily output cap, admin/profile changes and natural-ratio image previews. The latest profile change removes invited-user rows/pagination while retaining total invitation count, link, QR code and cashback presentation. Migration `0035` adds referral schema; all 36 migrations are included.

These latest changes were not deployed during this publication task. No production server, database, account, payment, OAuth or model operation is part of source publication. No automatic deployment workflow is included.

## Configuration and privacy

Start from `.env.example` and `deploy/cvm/*.env.example`; all real credentials and runtime data must be provisioned separately. `.openai/hosting.json` uses a placeholder project ID. Production account IDs/private-test IDs and a personal-hostname fallback were replaced with synthetic public examples. The admin-ordering sample is `ADMIN001`; the reserved test identity is `TEST0001`. These are source policy examples, not real account credentials, and must be reviewed for a new deployment. No live identity database is included.

The public tree excludes private operational history, user uploads, databases, backups, real env files, keys/certificates, screenshots and generated build artifacts. Historical reports from the private workspace are not published.

## Validation record

The prior local referral implementation recorded 623 server tests passing, 72 AI tests passing with 2 existing skips, 9 SSR checks and type/lint/Web/consumer builds. The subsequent invitation-count UI change recorded type/lint and component-render checks. These are historical results, not a claim that this export reran those suites or tested live integrations.

Current export checks passed: typecheck, direct ESLint, CVM Web build, consumer build, 68 affected server tests and 9 built-SSR checks. An initial test-fixture sanitation changed the SMTP domain incompatibly; the corrected synthetic provider-compatible fixture passed the rerun. An npm lint invocation selected an unrelated parent-directory executable; direct project ESLint passed. Independent publication checks are recorded by the maintainer separately. Package/build checks do not prove real login, SMTP, OAuth, payment or image-provider E2E.

Known inherited limitation: `scripts/migrate-user-ids.py` is an old existing-account ID migration utility and fails closed against the current 36-migration schema because its user-FK allowlist lacks newer OAuth/referral references. Its Python regression suite fails on that schema. Do not use it to migrate a current database until it has been separately extended and reviewed. This does not prevent applying the ordered SQL migrations to a new database. No live data migration was attempted.

## Next work and rollback

Verify current Git status and configuration before making changes. Review configuration, synthetic account policies, all environment overrides and migration state before any separately authorized deployment. The new consumer uses `.worker-1` and `.worker-2` spool children; drain/check all slots before reverting consumer versions. Preserve current databases, identities, sessions, ledger, rewards, orders, output objects and compatible consumers; never restore an old database over live state.

Source-only rollback is a reviewed revert commit. Deployment rollback requires a fresh review of the running version and current data; repository publication alone does not authorize it.
