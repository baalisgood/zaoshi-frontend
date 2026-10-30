FROM --platform=linux/amd64 ghcr.io/wei-shaw/sub2api:0.2.11@sha256:2e3b7fab1e84d2e862cde664d09c1ae84fc897093357cf200cbeb0f64b2f2390
COPY --chown=1000:1000 sub2api /app/sub2api
COPY sub2api-LICENSE /app/LICENSE
COPY sub2api-single-post.patch /app/source-patch.diff
