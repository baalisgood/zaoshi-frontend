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

## System prompt hardening — 2026-10-30 (not deployed)

Scope: user-authored text handling in live non-concept prompt paths and the prompt optimizer. The Astra-authored concept scheme prompts (v8–v10, new styles, industrial/french/walnut/oat-latte prose) and the floorplan prompt are unchanged; a per-prompt hash comparison against `main` confirmed all 1,512 concept-scheme records and the concept/floorplan fallbacks are byte-identical.

- `lib/ai/prompt.ts`: self-service `self-service-v2` fences the user brief in `"""…"""`, states it may be Chinese and is design content rather than rule changes, adds silent-brief defaults and aspect-ratio canvas extension, and states the "not a survey/construction drawing" boundary once instead of twice. Advanced `interior-concept-v27` (new `ADVANCED_PROMPT_TEMPLATE_VERSION`; `PROMPT_TEMPLATE_VERSION` stays v12) fences the user brief below the camera/geometry/opening rules, applies colour temperature to artificial light only, and replaces the trailing construction-drawing sentence with an avoid list for text, logos and annotations (the word "watermark" stays excluded per the existing guard). Local edit v2 prompt mode `local-edit-v4` fences user text and keeps it to the marked target; v1 history wording is untouched (`local-edit-v2`).
- `lib/server/prompt-optimization.ts`: `interior-optimize-v2` wraps user text in `<user_prompt>` tags (stripping embedded tags), keeps the output language equal to the input, preserves stated objects/quantities/positions/numbers, bans vague and tag-style filler, and returns the original text for non-interior input. `cleanOptimizedPrompt` strips code fences, echoed tags, labels and outer quotes before moderation and storage. A 2,000-character Chinese prompt still quotes at most 2 credits (7,512-byte cap).
- Checks run (after both changes): typecheck, ESLint, Web build, consumer build; server suite 618 pass / 9 fail and AI suite 72 pass; browser check that neither workbench shows 视觉表现 — the 9 server failures are identical on untouched `main` (8 missing unpublished `docs/*.md`, 1 frozen-prose check). `tests/rendered-html.test.mjs` fails 6 identically on untouched `main` (`cloudflare:` ESM scheme under plain Node). No paid provider call or image A/B was run; output quality is unverified.
- Visual realism removed from the 智能 (concept) and 高级 (advanced) workbench UIs: no control, no summary row, not submitted and not saved in new templates. `compileInteriorPrompt` now forces `photorealistic` for concept and advanced, so older jobs, templates, drafts and API callers that still send another level get the photo-level prompt. The API field, job column and hash rules are unchanged. Photo-level prompt bytes are unchanged (the pinned per-model photorealistic hashes still match). Self-service now defaults to a photorealistic completed-interior photograph unless the brief asks for another medium.
- Contracts: no schema, queue, pricing or API change. The optimizer template version is part of the quote hash, so quotes issued in the ~2 minutes before a deploy return `OPTIMIZATION_QUOTE_CHANGED` and must be re-quoted. Rollback is a source revert.

## 毛坯还原 mode — 2026-10-30 (not deployed)

The advanced workbench can strip an old, furnished photo back to a bare structural shell (毛坯结构图). At the product owner's request, because what users do next with a shell is unpredictable, shell results offer no follow-up actions: no hand-off to the smart workbench, no 高级精修, no 局部修改 and no 使用此图参数. Only task-list download (plus read-only preview and details) remains. A smart-workbench hand-off was built and then removed; it may return later.

- Job: an advanced job with `editInstruction = "bare-shell:v1"` (`lib/domain/bare-shell.ts`), following the existing `local-edit:v2:*` convention, so the job schema, queue work contract and consumer are unchanged. `parseCreateJobInput` accepts it only as an advanced final job with one source and no prompt, references, structure controls or mask (`INVALID_BARE_SHELL`). `compileInteriorPrompt` returns the dedicated `bare-shell-v1` prompt (keep camera, openings and ceiling height; remove all contents and old finishes; keep service points; remove when unsure). Job snapshots add `taskMode: "bare-shell"`.
- UI: advanced workbench 任务类型 switch (设计效果图 / 毛坯还原). In 毛坯还原 mode the local-edit, space/lighting and structure/design groups and the prompt box are hidden, and the shared `ReferenceTray` (`sourceOnly`) keeps but excludes every non-source slot. Results are titled 毛坯结构图 and point to the task list for download; task-list rows carry a 毛坯还原 tag and hide 使用此图参数. No new endpoint, no asset-kind change, no smart-workbench change.
- Billing: a bare-shell job is an ordinary generation quoted by the existing price path.
- Checks: typecheck, ESLint, Web and consumer builds; server 622 pass / 9 fail (the same 9 as untouched `main`), AI 72 pass; `tests/server/bare-shell.test.ts` covers contract rejection, prompt independence from style/lighting, `taskMode`, and a source contract that shell results expose no follow-up actions. Browser: advanced 毛坯还原 mode switch checked; no job was run because the local demo has no sign-in or database. No paid provider call was made; bare-shell output quality is unverified.

### Code-review fixes (same day)

- The paid-generation confirm summary for 毛坯还原 shows only 生成内容/画面比例/质量, never the `bare-shell:v1` token or ignored parameters. `buildAdvancedGenerationPayload({ bareShell: true })` builds the minimal payload (unit-tested); AdvancedStudio no longer hand-builds it.
- In `sourceOnly` mode only the source slot's upload state can block submission.
- `userEditInstruction()` keeps the mode token out of text moderation in all four entry points (jobs route, finalize, web processor, queued creation).
- `quoteUserText` collapses any run of 3+ quotes, so user text cannot close its fence early.
- Optimizer: length rule is per language (Chinese 150–600 字, English 80–300 words, ≤1800 chars in any language). The "echo unrelated input unchanged" rule is replaced by "complete around the original" so users are not charged for a verbatim copy. `cleanOptimizedPrompt` unwraps only one matched outer quote pair with no inner quote of that pair. The maximum quote is still 2 credits (7,622-byte cap).
- Checks after fixes: typecheck, ESLint, Web and consumer builds; server 625 pass / 9 fail (same 9 as `main`), AI 72 pass; browser check of the advanced 毛坯还原 mode.

## Compact workbench layout — 2026-10-30 (not deployed)

CSS only: one marked block at the end of `app/globals.css`, shared by the smart, advanced and self-service workbenches; no component changes.

- ≥1180px: smaller page intro and panel headings, a denser style grid (one-line descriptions), compact optional reference tiles (120px drop zones, four per row) with the site photo kept large, a smaller local-selection example, and tighter parameter-group padding. Interactive controls keep their existing heights (≥44px where they were).
- ≥2200px (2K and wider): page width up to 2400px; inputs | parameters | results in three columns with one page scroll. The parameter panel has no inner scroll and uses two CSS columns (heading spans both, groups never split). Its duplicate source thumbnail is hidden because the photo is visible in the inputs column.
- Below 2200px the original two-column layout with the sticky parameter panel is kept: three columns at 1920px made the parameter column too long. Phones are unchanged.
- Measured at 2560×1300 (local demo, no sign-in): smart 2.6→1.2 screens, advanced 2.6→1.4, self-service 1.6→1.0; no horizontal scroll at 2560, 1920, 1440 or 390px. Checks: typecheck, ESLint, Web and consumer builds, server 625 pass / 9 fail (same 9 as `main`), AI 72 pass.
- Not done: segmented buttons are still equal-width (the AGENTS.md content-width rule predates this change); collapsing expert parameter groups and moving helper text into hover hints need component changes.

## Next work and rollback

Verify current Git status and configuration before making changes. Review configuration, synthetic account policies, all environment overrides and migration state before any separately authorized deployment. The new consumer uses `.worker-1` and `.worker-2` spool children; drain/check all slots before reverting consumer versions. Preserve current databases, identities, sessions, ledger, rewards, orders, output objects and compatible consumers; never restore an old database over live state.

Source-only rollback is a reviewed revert commit. Deployment rollback requires a fresh review of the running version and current data; repository publication alone does not authorize it.
