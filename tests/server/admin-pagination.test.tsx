import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminPagination } from "../../components/admin/AdminPagination";

test("cursor pagination exposes current page count without invented totals", () => {
  const html = renderToStaticMarkup(createElement(AdminPagination, { pageNumber: 2, count: 25, hasNext: true, busy: false, previous() {}, next() {} }));
  assert.match(html, /数据分页/);
  assert.match(html, /第 2 页/);
  assert.match(html, /本页 25 条/);
  assert.doesNotMatch(html, /disabled|共.*页/);
});

test("first, final, empty and in-flight pages prevent invalid navigation", () => {
  for (const entry of [
    { pageNumber: 1, count: 25, hasNext: true, busy: false, disabled: 1 },
    { pageNumber: 140, count: 25, hasNext: false, busy: false, disabled: 1 },
    { pageNumber: 1, count: 0, hasNext: false, busy: false, disabled: 2 },
    { pageNumber: 2, count: 25, hasNext: true, busy: true, disabled: 2 },
  ]) {
    const html = renderToStaticMarkup(createElement(AdminPagination, { ...entry, previous() {}, next() {} }));
    assert.equal((html.match(/disabled=""/g) ?? []).length, entry.disabled);
    assert.equal(html.includes('role="status"'), entry.busy);
  }
});
