import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { RefreshLoader } from "../.compiled/src/refresh.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

test("pending callers share a promise and success releases the slot", async () => {
  const operations = [];
  const signals = [];
  const loader = new RefreshLoader((signal) => {
    signals.push(signal);
    const operation = deferred();
    operations.push(operation);
    return operation.promise;
  });
  const firstSignal = new AbortController().signal;
  const first = loader.load(firstSignal);
  const shared = loader.load(new AbortController().signal);
  assert.equal(shared, first);
  assert.equal(operations.length, 1);
  assert.equal(signals[0], firstSignal);
  operations[0].resolve("first value");
  assert.equal(await first, "first value");
  assert.equal(getEventListeners(firstSignal, "abort").length, 0);

  const next = loader.load(new AbortController().signal);
  assert.notEqual(next, first);
  assert.equal(operations.length, 2);
  operations[1].resolve("next value");
  assert.equal(await next, "next value");
});

test("backend rejection removes listeners and permits a fresh retry", async () => {
  let calls = 0;
  const failure = new Error("upstream unavailable");
  const loader = new RefreshLoader(() => {
    calls += 1;
    return calls === 1 ? Promise.reject(failure) : Promise.resolve("recovered");
  });
  const signal = new AbortController().signal;
  await assert.rejects(loader.load(signal), (error) => error === failure);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.equal(await loader.load(new AbortController().signal), "recovered");
  assert.equal(calls, 2);
});

test("an already aborted signal never starts the backend", async () => {
  let calls = 0;
  const loader = new RefreshLoader(() => {
    calls += 1;
    return Promise.resolve("should not load");
  });
  const controller = new AbortController();
  const reason = new Error("caller canceled before loading");
  controller.abort(reason);
  await assert.rejects(
    loader.load(controller.signal),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const staleOutcome of ["resolve", "reject"]) {
  test(`abort settles promptly and a late backend ${staleOutcome} cannot clear a newer load`, async () => {
    const operations = [];
    const loader = new RefreshLoader(() => {
      const operation = deferred();
      operations.push(operation);
      return operation.promise;
    });
    const controller = new AbortController();
    const reason = new Error("caller canceled pending load");
    const first = loader.load(controller.signal);
    let outcome = { status: "pending" };
    first.then(
      (value) => {
        outcome = { status: "resolved", value };
      },
      (error) => {
        outcome = { status: "rejected", error };
      },
    );
    controller.abort(reason);
    await flushMicrotasks();
    assert.deepEqual(outcome, { status: "rejected", error: reason });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);

    const second = loader.load(new AbortController().signal);
    assert.notEqual(second, first);
    assert.equal(operations.length, 2);
    if (staleOutcome === "resolve") operations[0].resolve("obsolete value");
    else operations[0].reject(new Error("obsolete backend failure"));
    await flushMicrotasks();
    assert.equal(loader.load(new AbortController().signal), second);
    assert.equal(operations.length, 2);
    operations[1].resolve("fresh value");
    assert.equal(await second, "fresh value");
  });
}

test("a synchronous backend throw becomes a rejection and remains recoverable", async () => {
  let calls = 0;
  const failure = new Error("backend threw synchronously");
  const loader = new RefreshLoader(() => {
    calls += 1;
    if (calls === 1) throw failure;
    return Promise.resolve("recovered after throw");
  });
  let first;
  assert.doesNotThrow(() => {
    first = loader.load(new AbortController().signal);
  });
  await assert.rejects(first, (error) => error === failure);
  assert.equal(
    await loader.load(new AbortController().signal),
    "recovered after throw",
  );
});
