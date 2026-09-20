import assert from "node:assert/strict";
import test from "node:test";
import { LatestRequest } from "../.compiled/src/latest.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledRequests() {
  const operations = new Map();
  const request = new LatestRequest((key) => {
    const operation = deferred();
    operations.set(key, operation);
    return operation.promise;
  });
  return { request, operations };
}

test("a stale success after the latest success cannot overwrite accepted data", async () => {
  const { request, operations } = controlledRequests();
  const older = request.refresh("older");
  const newer = request.refresh("newer");
  operations.get("newer").resolve("new data");
  await newer;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "new data",
    error: undefined,
  });
  operations.get("older").resolve("old data");
  await older;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "new data",
    error: undefined,
  });
});

test("a stale success while the latest request is pending must leave it loading", async () => {
  const { request, operations } = controlledRequests();
  const older = request.refresh("older");
  const newer = request.refresh("newer");
  operations.get("older").resolve("premature old data");
  await older;
  assert.deepEqual(request.read(), {
    status: "loading",
    data: undefined,
    error: undefined,
  });
  operations.get("newer").resolve("accepted new data");
  await newer;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "accepted new data",
    error: undefined,
  });
});

test("overlapping refreshes of the same key are still distinct requests", async () => {
  const operations = [];
  const request = new LatestRequest((key) => {
    assert.equal(key, "shared-key");
    const operation = deferred();
    operations.push(operation);
    return operation.promise;
  });
  const older = request.refresh("shared-key");
  const newer = request.refresh("shared-key");
  operations[1].resolve("latest version");
  await newer;
  operations[0].resolve("obsolete version of the same key");
  await older;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "latest version",
    error: undefined,
  });
});

test("a stale failure after the latest success cannot replace ready state", async () => {
  const { request, operations } = controlledRequests();
  const older = request.refresh("older");
  const newer = request.refresh("newer");
  operations.get("newer").resolve("fresh data");
  await newer;
  operations.get("older").reject(new Error("obsolete failure"));
  await older;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "fresh data",
    error: undefined,
  });
});

test("a stale failure before latest completion cannot publish an error", async () => {
  const { request, operations } = controlledRequests();
  const older = request.refresh("older");
  const newer = request.refresh("newer");
  operations.get("older").reject("obsolete non-Error failure");
  await older;
  assert.deepEqual(request.read(), {
    status: "loading",
    data: undefined,
    error: undefined,
  });
  operations.get("newer").resolve("current result");
  await newer;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "current result",
    error: undefined,
  });
});

test("a current failure preserves prior data even when an older success arrives later", async () => {
  const { request, operations } = controlledRequests();
  const seed = request.refresh("seed");
  operations.get("seed").resolve("stable data");
  await seed;
  const older = request.refresh("older");
  const newer = request.refresh("newer");
  assert.deepEqual(request.read(), {
    status: "loading",
    data: "stable data",
    error: undefined,
  });
  operations.get("newer").reject(new Error("current failure"));
  await newer;
  assert.deepEqual(request.read(), {
    status: "error",
    data: "stable data",
    error: "current failure",
  });
  operations.get("older").resolve("obsolete success");
  await older;
  assert.deepEqual(request.read(), {
    status: "error",
    data: "stable data",
    error: "current failure",
  });
});

test("a new refresh clears error and public snapshots cannot mutate state", async () => {
  const { request, operations } = controlledRequests();
  assert.deepEqual(request.read(), {
    status: "idle",
    data: undefined,
    error: undefined,
  });
  const failed = request.refresh("failed");
  operations.get("failed").reject("plain failure");
  await failed;
  assert.deepEqual(request.read(), {
    status: "error",
    data: undefined,
    error: "plain failure",
  });
  const next = request.refresh("next");
  assert.deepEqual(request.read(), {
    status: "loading",
    data: undefined,
    error: undefined,
  });
  const snapshot = request.read();
  snapshot.status = "ready";
  snapshot.data = "injected value";
  snapshot.error = "injected error";
  assert.deepEqual(request.read(), {
    status: "loading",
    data: undefined,
    error: undefined,
  });
  operations.get("next").resolve("real value");
  await next;
  assert.deepEqual(request.read(), {
    status: "ready",
    data: "real value",
    error: undefined,
  });
});
