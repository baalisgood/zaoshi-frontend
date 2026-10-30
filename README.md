# 造室 / Zaoshi

Complete application source snapshot: React frontend, server API routes, image-generation queue and consumer, authentication, payments, migrations and deployment templates. The repository name is historical; this tree includes both frontend and backend.

## Local development

Requires Node.js >=22.13.0 and npm. The checked-in examples contain no live credentials.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

The default `sites-demo` profile is for local UI work. It does not configure real OAuth, SMTP, payment or image-provider access. The Sites configuration contains a placeholder project ID; provision your own bindings before using that hosting target. For the Node/CVM target:

```sh
npm run typecheck
npm run lint
npm run build:cvm
npm run build:consumer
npm run test:server
npm run test:ai
```

`deploy/cvm/` contains Dockerfiles, Compose templates and guarded scripts. Configuration examples refer to mounted secret files under `/run/secrets`; create and permission your own files outside Git. Publishing this source does not deploy or configure a working service. Do not run paid provider smoke tests without explicit authorization.

## Current snapshot (2026-10-30)

- Three main workbenches, local image editing, task history, asset library, profile and administration interfaces.
- Email/password and optional WeChat OAuth, captcha, server sessions and account limits.
- Server-side pricing, credit ledger, WeChat Native payment integration and referral accounting (8% cash accrual; 5% extra package credits for qualifying invited top-ups).
- Profile referral panel shows invitation count, link and QR code; invitation detail rows are hidden.
- Default account activity concurrency is 3, pending output cap is 4, and daily output cap is removed. Explicit deployment queue settings still require review.
- Durable queue, fenced attempts, reconciliation, consumer recovery and three consumer slots for `cn-production` with email authentication.
- 36 ordered SQL migrations, ending at `0035_referrals_and_generation_limits.sql`.

Latest referral and concurrency changes were local-only at export time. Repository publication is independent of production deployment. The legacy account-ID migration Python utility is not compatible with the current schema; see its explicit limitation in the handoff. See [handoff.md](handoff.md) for boundaries and [AGENTS.md](AGENTS.md) for maintenance rules.

## Privacy and assets

This snapshot omits local Git history, credentials, real environment files, certificates, databases, user uploads, logs, build outputs, screenshots and private deployment records. Bundled `public/` files are product illustrations, style previews, icons and official provider/payment branding; see [ASSETS.md](ASSETS.md). Deployment-specific account identifiers in source fixtures were replaced consistently with synthetic IDs; configure your own account policy before deployment.

The existing [LICENSE](LICENSE) is retained from the previous frontend export. Its historical frontend grant is not a new license grant for all backend code or third-party assets. Review ownership and applicable terms before redistribution.
