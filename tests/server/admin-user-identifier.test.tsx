import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserIdentifier, userIdentifierLabel } from "../../components/admin/UserIdentifier";

test("user ID abbreviation is presentation only and retains colliding full identifiers accessibly", () => {
  const prefix = "222416dfe0d6";
  const ids = [`user_${prefix}${"a".repeat(52)}`, `user_${prefix}${"b".repeat(52)}`];
  for (const id of ids) {
    assert.equal(userIdentifierLabel(id), `${prefix}…`);
    const html = renderToStaticMarkup(createElement(UserIdentifier, { id }));
    assert.match(html, /<details><summary>/u); assert.match(html, /简写/u);
    assert.ok(html.includes(`aria-label="复制完整用户 ID ${id}"`)); assert.ok(html.includes(`>${id}</span>`));
  }
  assert.notEqual(ids[0], ids[1]);
});

test("legacy, malformed and non-user identifiers retain their original value", () => {
  for (const id of ["", "chatgpt:legacy", "private-test:operator", "user_short", `user_${"A".repeat(64)}`, `job_${"a".repeat(64)}`]) assert.equal(userIdentifierLabel(id), id);
});


test("eight character user IDs render once without redundant expansion", () => {
  for (const id of ["A3D7K9M2", "U0000001"]) {
    const html = renderToStaticMarkup(createElement(UserIdentifier, { id }));
    assert.equal(userIdentifierLabel(id), id);
    assert.ok(!html.includes("<details>"));
    assert.ok(!html.includes("简写"));
    assert.ok(html.includes(`aria-label="复制完整用户 ID ${id}"`));
    assert.ok(html.includes(`>${id}</span>`));
  }
});
