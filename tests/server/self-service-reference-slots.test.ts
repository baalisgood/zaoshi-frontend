import assert from "node:assert/strict";
import test from "node:test";
import { finishReferenceRestore, type ReferenceSlot } from "../../components/studio/SelfServiceStudio";

const slot = (key: string, extra: Partial<ReferenceSlot> = {}): ReferenceSlot => ({ key, state: "idle", ...extra });

test("restored empty reference slots collapse to one without changing image positions", () => {
  let slots = [slot("first"), slot("second"), slot("third")];
  slots = finishReferenceRestore(slots, "second", false);
  assert.equal(slots.length, 3, "the last slot may still contain a saved image");
  slots = finishReferenceRestore(slots, "third", false);
  assert.deepEqual(slots.map((item) => item.key), ["first"]);
  assert.equal(finishReferenceRestore(slots, "first", false).length, 1);

  const withImage = finishReferenceRestore([slot("first"), slot("second"), slot("third")], "third", true);
  assert.deepEqual(finishReferenceRestore(withImage, "second", false).map((item) => item.key), ["first", "second", "third"]);
  assert.equal(finishReferenceRestore(withImage, "unknown", false), withImage);
});

test("restore completion retains manually added slots and in-flight or failed selections", () => {
  for (const extra of [{ keepEmpty: true }, { state: "uploading" as const }, { state: "error" as const }, { image: { id: "saved", url: "blob:saved" } as ReferenceSlot["image"] }]) {
    const slots = finishReferenceRestore([slot("first"), slot("second", extra)], "second", false);
    assert.equal(slots.length, 2);
    assert.equal(finishReferenceRestore(slots, "second", false).length, 2);
  }
  const slots = [slot("first"), slot("old", { restoredEmpty: true }), slot("clicked", { keepEmpty: true })];
  assert.deepEqual(finishReferenceRestore(slots, "clicked", false).map((item) => item.key), ["first", "old", "clicked"]);
});
