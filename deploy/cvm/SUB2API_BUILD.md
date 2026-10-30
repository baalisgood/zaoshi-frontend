# Private official image relay

Fixed upstream: Wei-Shaw/sub2api v0.2.11, commit `96f4c115c9749078f90cbf210a01d39baf3f53b6`. Local patched source commit: `0ed4cccd3be77172fafe373798e07283da08eed5`. Apply `sub2api-single-post.patch` to that exact baseline; preserve its unchanged `LICENSE` (also supplied as `sub2api-LICENSE`). The narrow protected OpenAI OAuth path uses only the existing unexpired stored token and the native Codex Images endpoint; no token refresh, source vendor, new runtime dependency, schema, provider image test or automatic retry is included.

The six exact image models require the existing ordinary grouped gateway keys. Google uses its grouped API-key account; OpenAI accepts its grouped API-key or plain OAuth account. Non-exact allowlist variants, shadow identities, model mapping, proxy/plugin and account substitution are rejected before sending. Protected OAuth uses only https://chatgpt.com/backend-api/codex/images/generations or /edits with n=1, and rejects a known expired or imminently expiring stored token before transport; it never refreshes tokens or falls back to Responses. Their shared budget allows one official-origin POST, no redirect/proxy/plugin/model rewrite, HTTP/1.1 without connection reuse, and the original absolute deadline through body reads. Gateway responses are bounded to 12MiB success / 64KiB error. Actual upstream headers flush their real status and dedicated provider ID before decoder initialization or body reading. A flushed 200 with invalid or incomplete output remains uncertain at the website. Google accepts only a single STOP candidate and one non-thought inline image; `responseId` is used only from a complete successful native body, never arbitrary `id`. PNG/JPEG/WebP are validated under the existing 8MiB output limit; high-resolution PNG may exceed it and require reconciliation. See [Google protocol](https://ai.google.dev/api/generate-content) and [legacy image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation).

Reproduce locally; build the unchanged upstream UI and legal documents with its frozen lockfile, then cross-compile for AWS Linux amd64. Use Go 1.27.1 (official Darwin arm64 archive SHA256 `ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12`) and pnpm 9.15.9. Replace only the tool/cache/output paths below as appropriate.

```sh
# Start at the fixed upstream checkout, with this directory's patch accessible.
git apply --check /path/to/sub2api-single-post.patch
git apply /path/to/sub2api-single-post.patch
cd frontend
npx --yes pnpm@9.15.9 install --frozen-lockfile
npx --yes pnpm@9.15.9 run build
cd ../backend
export GOTOOLCHAIN=local GOMAXPROCS=2
export GOPATH=/private/tmp/zaoshi-go-path-20261001 GOCACHE=/private/tmp/zaoshi-go-cache-20261001
export ZAOSHI_WEBSITE_SOURCE=/path/to/website-checkout
/private/tmp/zaoshi-go-toolchain-20261001/go/bin/go test -tags 'unit zaoshi_integration' -p=1 ./internal/repository ./internal/service ./internal/handler -run 'TestZaoshi|TestOpenAIGatewayHandlerImages_Disabled|Test.*Usage.*RequestID|Test.*UsageRecordTask' -count=1
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 /private/tmp/zaoshi-go-toolchain-20261001/go/bin/go build -p=1 -buildvcs=false -tags embed -trimpath -ldflags '-s -w -X main.Version=0.2.11-zaoshi -X main.Commit=0ed4cccd3be77172fafe373798e07283da08eed5 -X main.Date=2026-10-01T00:00:00Z -X main.BuildType=release' -o /path/to/runtime-context/sub2api ./cmd/server
```

The runtime build context contains only that binary, `sub2api-LICENSE`, `sub2api-single-post.patch`, and `sub2api-runtime.Dockerfile`. Build with `docker build --platform linux/amd64 -f sub2api-runtime.Dockerfile -t <reviewed-private-tag> .`; the base is the pinned official runtime, retaining its entrypoint, CA certificates, resources and permissions. No AWS compilation is needed.

Consumer uses only `/var/lib/zaoshi/overseas-sockets/sub2api.sock` (directory 10001:10001/0700, socket 10001:10001/0600) and separate `/run/secrets/{openai,google}-gateway-key` files. Restricted SSH permits only AWS `127.0.0.1:8080`; official credentials remain on AWS. Prepare a locked nologin host UID/GID 10001 and the unit's read-only SSH namespace bind without changing `/etc/zaoshi` permissions. Existing direct API-key configuration fails closed. Enabling or deploying remains a separate coordinator gate.

A real TLS gzip/zstd stalled-body regression verifies headers are observed once before decoder body reads. Tests separate production TLS/ALPN wire counting (six models, failures/limits/concurrency) from handler/service/account-selection tests with two eligible accounts and a real local upstream. `zaoshi_integration` additionally runs the actual website transport over Unix HTTP through Gin/service to the fake upstream for OpenAI slow, invalid, oversize and truncated bodies, plus Google slow bodies; it requires Node/tsx from the website checkout. Fixtures contain no real credentials. Roll back code only after draining attempts; preserve current volumes, images, ledger and reconciliation records, and never replay an uncertain attempt.
