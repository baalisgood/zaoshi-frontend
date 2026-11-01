# Zaoshi collaboration rules

Read `handoff.md`, this file, `README.md`, the applicable source and tests before editing. Verify the actual Git status and preserve unrelated changes. This repository root is the complete product source.

- Use the smallest change that satisfies the request. Preserve public API, money/credit, authentication and queue contracts unless explicitly changing them.
- Use one writer per checkout. For production-code or multi-file changes: planner scopes work; builder implements; independent reviewer and QA inspect the actual diff and run relevant checks. Include security review for authentication, payments, secrets, user data or external integrations, and architecture review for schema, queue, persistence or concurrency changes.
- Secrets must remain outside Git. Commit only blank/placeholder configuration examples. Do not add live identifiers, user images, databases, account records, personal addresses, deployment logs or local filesystem paths.
- Synthetic fixture IDs `ADMIN001` and `TEST0001` do not identify real accounts or grant roles. Review pinned ordering/private-test policy before deploying your own instance.
- Append migrations; do not rewrite migrations already applied to an environment. Preserve live data, ledger facts, identities, objects and queued work during deployment and rollback.
- Run typecheck, lint and affected tests. Build both Web and consumer for shared runtime changes. UI changes require real browser verification; mock tests do not prove OAuth/payment/provider E2E.
- Do not push, deploy, change repository visibility, migrate live data or make paid provider calls without authorization covering that action. Source publication does not authorize deployment.
- Keep `handoff.md` current with scope, changed files, actual commands/results, independent review/QA, limitations and rollback. Separate historical evidence from current checks.

## Provider and subscription investigations

- Distinguish the website's Sub2API gateway key from the upstream account credential. Verify the selected group, upstream account type and running relay version read-only; never infer official API billing or authorization from a group name or an API-shaped request.
- Distinguish ChatGPT web image generation, Codex Images OAuth and the public Images API. Serialized `model`/`quality` values and mock tests do not establish that an upstream account supports or honors those values. Do not describe a web UI as a fixed API quality tier without official evidence.
- Keep user-visible provider/model names accurate. Do not silently map a named model to a different provider. Subscription quotas, API credits, commercial permissions and regional requirements need separate, dated checks against official sources; connectivity is not proof of permission or regulatory exemption.
- Research does not authorize account substitution, relay changes, purchases, paid generation or deployment. Keep live account/group IDs, credential fingerprints and operational records out of these public documents; record sanitized findings and verification limits in `handoff.md`.
