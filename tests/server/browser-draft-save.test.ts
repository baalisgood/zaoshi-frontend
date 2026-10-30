import assert from "node:assert/strict";
import test from "node:test";
import { imageFitsModel } from "../../components/studio/input-limits";

test("an invalidated replacement cannot overwrite the existing browser draft during IndexedDB save", async () => {
  const rows = new Map<string, unknown>();
  let putStarted: (() => void) | undefined;
  let releasePut: (() => void) | undefined;
  let holdPut = false;
  let openCount = 0; let holdOpen = -1; let openStarted: (() => void) | undefined; let releaseOpen: (() => void) | undefined;
  let holdGet = false; let getStarted: (() => void) | undefined; let releaseGet: (() => void) | undefined;
  const request = (result?: unknown, delay?: Promise<void>) => {
    const item = { result, error: null, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    void (async () => { await delay; queueMicrotask(() => item.onsuccess?.()); })();
    return item;
  };
  const database = {
    createObjectStore() {}, close() {},
    transaction() {
      const transaction = { oncomplete: null as null | (() => void), onerror: null, onabort: null, error: null,
        objectStore() { return {
          openCursor: () => { queueMicrotask(() => transaction.oncomplete?.()); return request(null); },
          get: (id: string) => request(rows.get(id), holdGet ? new Promise<void>((resolve) => { releaseGet = resolve; getStarted?.(); }) : undefined),
          put: (value: { id: string }) => {
            rows.set(value.id, value);
            const delay = holdPut ? new Promise<void>((resolve) => { releasePut = resolve; putStarted?.(); }) : undefined;
            return request(value.id, delay);
          },
          delete: (id: string) => { rows.delete(id); return request(undefined); },
          clear: () => { rows.clear(); return request(undefined); },
        }; },
      };
      return transaction;
    },
  };
  Object.assign(globalThis, {
    sessionStorage: { values: new Map<string, string>(), getItem(key: string) { return this.values.get(key) ?? null; }, setItem(key: string, value: string) { this.values.set(key, value); }, removeItem(key: string) { this.values.delete(key); } },
    indexedDB: { open() { const item = { result: database, error: null, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null }; const finish = () => queueMicrotask(() => { item.onupgradeneeded?.(); item.onsuccess?.(); }); if (++openCount === holdOpen) { releaseOpen = finish; openStarted?.(); } else finish(); return item; } },
  });
  const { saveDraftImage, loadDraftImage, removeDraftImage, clearBrowserDrafts, localDraft, captureDraftSession } = await import("../../components/studio/browser-drafts");
  const oldFile = new File(["old"], "old.png", { type: "image/png" });
  const old = await saveDraftImage("test:source", "source", oldFile, 100, 100);
  let currentModel = "qwen-image-3.0" as "qwen-image-3.0" | "doubao-seedream-4-5-251128";
  const started = new Promise<void>((resolve) => { putStarted = resolve; });
  holdPut = true;
  const newFile = new File(["new"], "new.png", { type: "image/png" });
  const replacing = saveDraftImage("test:source", "source", newFile, 10, 100, undefined, () => imageFitsModel(currentModel, { byteSize: newFile.size, width: 10, height: 100 }));
  await started;
  currentModel = "doubao-seedream-4-5-251128"; // Seedream rejects the 10px side while the write is in flight
  holdPut = false;
  releasePut?.();
  await assert.rejects(replacing, /图片选择已失效/u);
  const restored = await loadDraftImage("test:source");
  assert.equal(restored?.fileName, old.fileName);
  assert.equal(restored?.byteSize, old.byteSize);

  currentModel = "qwen-image-3.0";
  const committed = await saveDraftImage("test:committed", "source", newFile, 10, 100, undefined, () => imageFitsModel(currentModel, { byteSize: newFile.size, width: 10, height: 100 }));
  currentModel = "doubao-seedream-4-5-251128"; // a later model downgrade retains the committed image
  assert.equal((await loadDraftImage("test:committed"))?.draftVersion, committed.draftVersion);
  assert.equal(imageFitsModel(currentModel, { byteSize: newFile.size, width: 10, height: 100 }), false);

  const base1 = await saveDraftImage("advanced:source", "source", oldFile, 100, 100);
  const oldControlKey = `advanced:depth:${base1.draftVersion}`;
  await saveDraftImage(oldControlKey, "depth", oldFile, 100, 100);
  assert.equal((await loadDraftImage("advanced:source"))?.draftVersion, base1.draftVersion);
  assert.equal((await loadDraftImage(oldControlKey))?.fileName, oldFile.name);
  const base2 = await saveDraftImage("advanced:source", "source", newFile, 100, 100);
  assert.notEqual(base2.draftVersion, base1.draftVersion);
  assert.equal(await loadDraftImage(`advanced:depth:${base2.draftVersion}`), undefined);

  let activeSource = base1.draftVersion;
  const pendingStarted = new Promise<void>((resolve) => { putStarted = resolve; });
  holdPut = true;
  const staleControl = saveDraftImage(oldControlKey, "depth", newFile, 100, 100, undefined, () => activeSource === base1.draftVersion);
  await pendingStarted;
  activeSource = base2.draftVersion;
  holdPut = false;
  releasePut?.();
  await assert.rejects(staleControl, /图片选择已失效/u);
  await removeDraftImage(oldControlKey);
  assert.equal(await loadDraftImage(oldControlKey), undefined);
  const sessionCurrent = captureDraftSession();
  const clearStarted = new Promise<void>((resolve) => { putStarted = resolve; });
  holdPut = true;
  const acrossClear = saveDraftImage("local:private", "source", oldFile, 100, 100);
  await clearStarted;
  await clearBrowserDrafts(); holdPut = false; releasePut?.();
  await assert.rejects(acrossClear, /图片选择已失效/u);
  assert.equal(sessionCurrent(), false);
  assert.equal(await loadDraftImage("local:private"), undefined);
  assert.equal(localDraft(old.id), undefined);
  assert.equal(rows.size, 0);

  const beforeLoad = await saveDraftImage("clear:load", "source", oldFile, 100, 100);
  const loadingStarted = new Promise<void>((resolve) => { getStarted = resolve; });
  holdGet = true;
  const loading = loadDraftImage("clear:load"); await loadingStarted;
  await clearBrowserDrafts(); holdGet = false; releaseGet?.();
  assert.equal(await loading, undefined); assert.equal(localDraft(beforeLoad.id), undefined); assert.equal(rows.size, 0);

  await saveDraftImage("clear:restore", "source", oldFile, 100, 100);
  let allowed = true;
  const replacingStarted = new Promise<void>((resolve) => { putStarted = resolve; });
  holdPut = true;
  const restoring = saveDraftImage("clear:restore", "source", newFile, 100, 100, undefined, () => allowed);
  await replacingStarted; allowed = false; holdGet = true;
  const restoreRead = new Promise<void>((resolve) => { getStarted = resolve; });
  holdPut = false; releasePut?.(); await restoreRead;
  await clearBrowserDrafts(); holdGet = false; releaseGet?.();
  await assert.rejects(restoring, /图片选择已失效/u); assert.equal(rows.size, 0);

  const openingStarted = new Promise<void>((resolve) => { openStarted = resolve; });
  holdOpen = openCount + 2; // Pause opening the database for the replacement write itself.
  const opening = saveDraftImage("clear:opening", "source", oldFile, 100, 100);
  await openingStarted; await clearBrowserDrafts(); releaseOpen?.();
  await assert.rejects(opening, /图片选择已失效/u); assert.equal(rows.size, 0);
});
