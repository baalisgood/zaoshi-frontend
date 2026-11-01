import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { listPublicStylePresets } from "../../lib/ai/styles";

type Element = { type: unknown; props: Record<string, unknown> };
const styles = listPublicStylePresets().map(style => ({ ...style, imageUrl: style.preview }));
const ids = ["modern-minimalist", "cream-cozy", "wabi-sabi", "italian-minimalist", "contemporary-luxury", "nordic-natural", "new-chinese", "mid-century-modern", "japandi", "french-modern", "industrial-loft", "coastal-relaxed", "traditional-chinese", "european-classical", "american-traditional", "american-modern", "art-deco"];

// Exercise the actual component's events/effects; browser geometry/rendering is checked separately.
function harness(width = 1440, height = 900) {
  let index = 0, tree: Element, selected = styles[0].id;
  let focusTop = 200;
  const slots: unknown[] = [], deps: unknown[][] = [];
  const effects: Array<() => void> = [], cleanups = new Map<number, () => void>();
  const listeners = new Map<string, Set<(event: { key?: string }) => void>>();
  const changes: string[] = [];
  const body = {};
  const same = (a: unknown[] | undefined, b: unknown[]) => Boolean(a) && a!.length === b.length && a!.every((v, i) => Object.is(v, b[i]));
  const react = {
    useId() { return `style-preview-${index++}`; },
    useCallback(callback: unknown) { index++; return callback; },
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { slots[i] = next; render(); }]; },
    useEffect(effect: () => void | (() => void), next: unknown[]) { const i = index++; if (!same(deps[i], next)) { deps[i] = next; effects.push(() => { cleanups.get(i)?.(); const cleanup = effect(); if (cleanup) cleanups.set(i, cleanup); else cleanups.delete(i); }); } },
  };
  const jsx = { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }), Fragment: "fragment" };
  const exports = {} as { StylePicker: (props: unknown) => Element };
  const source = ts.transpileModule(readFileSync("components/studio/StudioFields.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(source, {
    exports, require: (name: string) => name === "react" ? react : name === "react/jsx-runtime" ? jsx : name === "react-dom" ? { createPortal: (children: unknown, target: unknown) => ({ type: "portal", props: { children, target } }) } : {},
    document: { body }, window: {
      innerWidth: width, innerHeight: height,
      addEventListener(name: string, handler: (event: { key?: string }) => void, capture = false) { const key = `${name}:${capture}`; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key)!.add(handler); },
      removeEventListener(name: string, handler: (event: { key?: string }) => void, capture = false) { listeners.get(`${name}:${capture}`)?.delete(handler); },
    },
  });
  function render() { index = 0; tree = exports.StylePicker({ styles, value: selected, onChange: (id: string) => { changes.push(id); selected = id; render(); } }); while (effects.length) effects.shift()!(); }
  function elements(node: unknown): Element[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const element = node as Element; return [element, ...elements(element.props.children)];
  }
  function buttons() { return elements(tree).filter(e => e.type === "button"); }
  function image(index: number) { return elements(buttons()[index]).find(e => e.props.className === "style-option-image")!; }
  render();
  return {
    changes, buttons, image,
    get preview(): Element | undefined { return elements(tree).find(e => e.props.role === "tooltip"); },
    get portalTarget() { return elements(tree).find(e => e.type === "portal")?.props.target; },
    get body() { return body; },
    get listenerCount() { return [...listeners.values()].reduce((sum, group) => sum + group.size, 0); },
    hover(index: number, pointerType = "mouse", rect = { left: 80, right: 240, top: 400, bottom: 480 }) { (image(index).props.onPointerEnter as (event: unknown) => void)({ pointerType, currentTarget: { getBoundingClientRect: () => rect } }); },
    leave(index: number) { (image(index).props.onPointerLeave as () => void)(); },
    focus(index: number, visible = true) { (buttons()[index].props.onFocus as (event: unknown) => void)({ currentTarget: { matches: () => visible, querySelector: () => ({ getBoundingClientRect: () => ({ left: 80, right: 240, top: focusTop, bottom: focusTop + 80 }), closest: () => ({ matches: () => visible }) }) } }); },
    setFocusTop(value: number) { focusTop = value; },
    blur(index: number) { (buttons()[index].props.onBlur as () => void)(); },
    touch(index: number) { (buttons()[index].props.onPointerDown as (event: unknown) => void)({ pointerType: "touch" }); },
    click(index: number) { (buttons()[index].props.onClick as () => void)(); },
    dispatch(name: string, event: { key?: string } = {}, capture = false) { for (const handler of [...(listeners.get(`${name}:${capture}`) ?? [])]) handler(event); },
    unmount() { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); },
  };
}

test("all 17 existing styles retain order, content and image identity while hover previews escape the cards", () => {
  assert.deepEqual(styles.map(s => s.id), ids);
  const h = harness(); assert.equal(h.buttons().length, 17); assert.equal(h.preview, undefined);
  for (const [i, style] of styles.entries()) {
    accessSync(`public${style.imageUrl}`);
    assert.equal(h.buttons()[i].props.onPointerEnter, undefined, "card/title hover must not trigger preview");
    h.hover(i); const preview: Element = h.preview!; assert.ok(preview); assert.equal(h.portalTarget, h.body);
    const image = preview.props.children as Element; assert.equal(image.type, "img"); assert.equal(image.props.src, style.imageUrl); assert.match(String(image.props.alt), new RegExp(style.name));
    assert.equal(h.buttons()[i].props["aria-describedby"], preview.props.id); assert.equal(h.buttons().length, 17); assert.equal(h.changes.length, 0);
    h.leave(i); assert.equal(h.preview, undefined);
  }
  h.click(16); assert.deepEqual(h.changes, [styles[16].id]); assert.equal(h.buttons()[16].props["aria-pressed"], true); assert.equal(h.buttons()[0].props["aria-pressed"], false); h.unmount();
});

test("keyboard focus previews without selecting; blur and Escape dismiss, ordinary mouse focus does not reopen", () => {
  const h = harness(); h.focus(2); assert.ok(h.preview); assert.equal(h.changes.length, 0);
  h.dispatch("keydown", { key: "Enter" }); assert.ok(h.preview); h.dispatch("keydown", { key: "Escape" }); assert.equal(h.preview, undefined);
  h.focus(3); assert.ok(h.preview); h.blur(3); assert.equal(h.preview, undefined);
  h.focus(4, false); assert.equal(h.preview, undefined); h.hover(4); h.click(4); h.leave(4); h.focus(4, false); assert.equal(h.preview, undefined); h.unmount();
});

test("touch keeps the original single-tap selection without opening or retaining a preview", () => {
  const h = harness(); h.hover(1, "touch"); h.focus(1, false); assert.equal(h.preview, undefined);
  h.touch(1); h.click(1); assert.deepEqual(h.changes, [styles[1].id]); assert.equal(h.preview, undefined);
  h.hover(2); assert.ok(h.preview); h.touch(2); assert.equal(h.preview, undefined); h.unmount();
});

test("scroll including nested scroll, resize and unmount remove preview listeners", () => {
  const h = harness(); h.hover(0); assert.equal(h.listenerCount, 3); h.dispatch("scroll", {}, true); assert.equal(h.preview, undefined); assert.equal(h.listenerCount, 0);
  h.hover(1); h.dispatch("resize"); assert.equal(h.preview, undefined); assert.equal(h.listenerCount, 0);
  h.hover(2); h.unmount(); assert.equal(h.listenerCount, 0);
});

test("focus-induced scrolling keeps keyboard preview anchored, while scrolling its image offscreen dismisses", () => {
  const h = harness(); h.focus(5); assert.ok(h.preview);
  h.setFocusTop(320); h.dispatch("scroll", {}, true); assert.ok(h.preview); assert.equal((h.preview.props.style as { top: number; height: number }).top + (h.preview.props.style as { height: number }).height, 400); assert.equal(h.changes.length, 0);
  h.setFocusTop(-100); h.dispatch("scroll", {}, true); assert.equal(h.preview, undefined); h.unmount();
});

for (const [width, height, rect] of [[1440, 900, { left: 1230, right: 1400, top: 800, bottom: 880 }], [390, 600, { left: 220, right: 375, top: 550, bottom: 590 }], [1440, 900, { left: 80, right: 240, top: 0, bottom: 80 }], [1440, 900, { left: 80, right: 240, top: 850, bottom: 930 }]] as const) test(`insufficient enlargement space or offscreen bottom hides preview at ${width}x${height}: ${rect.left},${rect.top}`, () => {
  const h = harness(width, height); h.hover(0, "mouse", rect); assert.equal(h.preview, undefined);
  h.click(0); assert.deepEqual(h.changes, [styles[0].id]); assert.equal(h.buttons()[0].props["aria-pressed"], true); h.unmount();
});

test("desktop preview stays right of the original image with aligned bottom edge", () => {
  const h = harness(); h.hover(0); const box = h.preview!.props.style as { left: number; top: number; height: number }; assert.equal(box.left, 256); assert.equal(box.top + box.height, 480); h.unmount();
});
