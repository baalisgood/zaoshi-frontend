import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function runSafeCompose(imageTag: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["deploy/cvm/web-compose-safe.sh", "config"], {
      env: { ...process.env, ZAOSHI_WEB_IMAGE_TAG: imageTag },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("CVM web image is immutable, single-process and loopback-only", async () => {
  const [dockerfile, compose, dockerignore, gitignore, safeCompose, consumerCompose] =
    await Promise.all([
      readFile("deploy/cvm/web.Dockerfile", "utf8"),
      readFile("deploy/cvm/web.compose.yaml", "utf8"),
      readFile(".dockerignore", "utf8"),
      readFile(".gitignore", "utf8"),
      readFile("deploy/cvm/web-compose-safe.sh", "utf8"),
      readFile("deploy/cvm/compose.yaml", "utf8"),
    ]);
  assert.equal(
    (dockerfile.match(/node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5/gu) ?? []).length,
    2,
  );
  assert.match(
    dockerfile,
    /ENTRYPOINT \["flock", "-n", "-F", "-E", "73", "\/var\/lib\/zaoshi\/db\/\.web\.lock", "node", "\/app\/server\.js"\]/u,
  );
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(compose, /127\.0\.0\.1:3000:3000/u);
  assert.match(compose, /container_name: zaoshi-web/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /cap_drop:\s+- ALL/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.doesNotMatch(compose, /^\s+build:/mu);
  assert.match(safeCompose, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(dockerignore, /^\/deploy\/cvm\/web\.env$/mu);
  assert.match(dockerignore, /^\*\*\/\.env\*$/mu);
  assert.match(gitignore, /^\/deploy\/cvm\/web\.env$/mu);
  assert.match(
    consumerCompose,
    /\/var\/lib\/zaoshi\/consumer:\/var\/lib\/zaoshi/u,
  );
  assert.match(compose, /BACKEND_PROFILE: sites-demo/u);
  assert.match(compose, /TRUST_PLATFORM_IDENTITY_HEADERS: "0"/u);
  assert.match(compose, /GENERATION_INTERNAL_API_ENABLED: "0"/u);
  assert.match(compose, /web-loopback-publish:\s+gw_priority: 1/u);
  assert.match(
    compose,
    /com\.docker\.network\.bridge\.enable_ip_masquerade: "false"/u,
  );
});

test("CVM web compose wrapper rejects mutable and abbreviated image tags", async () => {
  for (const imageTag of ["latest", "local", "c9b65b9", "A".repeat(40)]) {
    const result = await runSafeCompose(imageTag);
    assert.equal(result.code, 64, imageTag);
    assert.match(result.stderr, /full 40-character lowercase Git SHA/u);
  }
});
