import assert from "node:assert/strict";
import test from "node:test";

import { TaskRequestCoordinator } from "../../components/studio/task-request-coordinator";

test("refresh requested during an active load is replayed after that load finishes", () => {
  const coordinator = new TaskRequestCoordinator();
  const initial = coordinator.begin("replace");
  assert.equal(typeof initial, "number");
  assert.equal(coordinator.begin("replace"), null);
  assert.equal(coordinator.finish(initial!), true);
  const replay = coordinator.begin("replace");
  assert.equal(typeof replay, "number");
  assert.equal(coordinator.isCurrent(replay!), true);
  assert.equal(coordinator.finish(replay!), false);
});

test("cancel invalidates the old response and allows a fresh request", () => {
  const coordinator = new TaskRequestCoordinator();
  const old = coordinator.begin("replace")!;
  coordinator.cancel();
  assert.equal(coordinator.isCurrent(old), false);
  assert.equal(coordinator.finish(old), false);
  const next = coordinator.begin("replace");
  assert.equal(typeof next, "number");
  assert.notEqual(next, old);
});
