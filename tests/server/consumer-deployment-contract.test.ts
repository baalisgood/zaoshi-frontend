import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function runSafeCompose(imageTag: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["deploy/cvm/compose-safe.sh", "config"], {
      env: { ...process.env, ZAOSHI_CONSUMER_IMAGE_TAG: imageTag },
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

test("CVM container uses a kernel lock and fixed non-root security boundary", async () => {
  const [dockerfile, compose, dockerignore, safeCompose] = await Promise.all([
    readFile("deploy/cvm/Dockerfile", "utf8"),
    readFile("deploy/cvm/compose.yaml", "utf8"),
    readFile(".dockerignore", "utf8"),
    readFile("deploy/cvm/compose-safe.sh", "utf8"),
  ]);
  assert.equal(
    (dockerfile.match(/node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5/gu) ?? []).length,
    2,
  );
  assert.match(
    dockerfile,
    /ENTRYPOINT \["flock", "-n", "-F", "-E", "73", "\/var\/lib\/zaoshi\/\.consumer\.lock", "node", "\/app\/consumer\.mjs"\]/u,
  );
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(dockerfile, /\/app\/node_modules\/@img\//u);
  assert.match(
    compose,
    /image: zaoshi-generation-consumer:\$\{ZAOSHI_CONSUMER_IMAGE_TAG:\?set ZAOSHI_CONSUMER_IMAGE_TAG to the full release commit SHA\}/u,
  );
  assert.doesNotMatch(compose, /^\s+build:/mu);
  assert.doesNotMatch(compose, /zaoshi-generation-consumer:local/u);
  assert.match(safeCompose, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(compose, /user: "10001:10001"/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /cap_drop:\s+- ALL/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.doesNotMatch(compose, /ports:/u);
  assert.match(dockerignore, /^\.env\*$/mu);
  assert.match(dockerignore, /^\*\.pem$/mu);
});

test("CVM compose wrapper rejects mutable and abbreviated image tags", async () => {
  for (const imageTag of ["latest", "local", "6fca13e", "A".repeat(40)]) {
    const result = await runSafeCompose(imageTag);
    assert.equal(result.code, 64, imageTag);
    assert.match(result.stderr, /full 40-character lowercase Git SHA/u);
  }
});
