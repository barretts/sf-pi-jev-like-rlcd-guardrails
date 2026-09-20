import assert from "node:assert/strict";
import test from "node:test";
import { pageWindow } from "../.compiled/src/window.js";

test("a full window includes the row before its exclusive endpoint", () => {
  assert.deepEqual(pageWindow(["a", "b", "c", "d", "e"], 1, 3), {
    items: ["b", "c", "d"],
    start: 1,
    endExclusive: 4,
    hasMore: true,
  });
});

test("the final page includes its last row and reports no later page", () => {
  assert.deepEqual(pageWindow(["a", "b", "c", "d", "e"], 3, 8), {
    items: ["d", "e"],
    start: 3,
    endExclusive: 5,
    hasMore: false,
  });
  assert.deepEqual(pageWindow(["only"], 0, 1), {
    items: ["only"],
    start: 0,
    endExclusive: 1,
    hasMore: false,
  });
});

test("empty and exhausted input have equal clamped endpoints", () => {
  for (const [rows, start] of [
    [[], 0],
    [[], 9],
    [["a", "b"], 2],
    [["a", "b"], 20],
  ]) {
    assert.deepEqual(pageWindow(rows, start, 4), {
      items: [],
      start: rows.length,
      endExclusive: rows.length,
      hasMore: false,
    });
  }
});

test("consecutive windows partition rows without missing or duplicating boundaries", () => {
  const rows = Array.from({ length: 11 }, (_, index) => `row-${index}`);
  for (const size of [1, 2, 3, 5, 11, 20]) {
    const collected = [];
    let start = 0;
    do {
      const window = pageWindow(rows, start, size);
      assert.equal(window.items.length, window.endExclusive - window.start);
      assert.equal(window.hasMore, window.endExclusive < rows.length);
      if (window.hasMore) {
        assert.ok(
          window.endExclusive > start,
          "a non-final window must advance",
        );
      }
      collected.push(...window.items);
      start = window.endExclusive;
      if (!window.hasMore) break;
    } while (start < rows.length);
    assert.deepEqual(collected, rows, `partition failed for size ${size}`);
  }
});

test("row references are preserved and the returned array is independent", () => {
  const first = Object.freeze({ id: "first" });
  const second = Object.freeze({ id: "second" });
  const rows = Object.freeze([first, second]);
  const window = pageWindow(rows, 0, 2);
  assert.notEqual(window.items, rows);
  assert.equal(window.items[0], first);
  assert.equal(window.items[1], second);
  window.items.pop();
  assert.deepEqual(rows, [first, second]);
});

test("invalid index and size values fail explicitly", () => {
  for (const start of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(() => pageWindow(["a"], start, 1), RangeError);
  }
  for (const size of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(() => pageWindow(["a"], 0, size), RangeError);
  }
});
