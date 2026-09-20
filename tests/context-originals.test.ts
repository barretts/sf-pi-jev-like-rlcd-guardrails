import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_ORIGINALS_DEFAULT_MAX_BYTES,
  CONTEXT_ORIGINALS_DEFAULT_MAX_SOURCES,
  CONTEXT_ORIGINALS_MAX_CAPTURE_BYTES,
  CONTEXT_ORIGINALS_MAX_READ_BYTES,
  CONTEXT_ORIGINALS_READ_ERROR,
  CONTEXT_ORIGINALS_READ_PARAMETERS,
  createContextOriginals,
  type ContextOriginalCapture,
  type ContextOriginalReadRequest,
  type ContextOriginalReadResult,
  type ContextOriginalSource,
  type ContextOriginalStore,
  type ContextOriginalsOptions,
} from "../src/context-originals.js";

function capture(
  store: ContextOriginalStore,
  text: string,
  toolCallId = "invented-call",
  contentIndex = 0,
): ContextOriginalSource {
  const source = store.capture({ toolCallId, contentIndex, text });
  expect(source).toBeDefined();
  return source!;
}

function read(
  store: ContextOriginalStore,
  input: ContextOriginalReadRequest,
): ContextOriginalReadResult {
  const result = store.read(input);
  expect(result).not.toHaveProperty("error");
  if ("error" in result) throw new Error("Unexpected fixed read error");
  expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
    CONTEXT_ORIGINALS_MAX_READ_BYTES,
  );
  return result;
}

describe("context originals", () => {
  it("issues immutable opaque references with exact UTF-8 source metadata", () => {
    const store = createContextOriginals();
    const text = "alpha\r\nβeta\r😀 final";
    const source = capture(store, text);
    expect(source).toEqual({
      reference: expect.stringMatching(/^ctxorig_[0-9a-f]{48}$/),
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      bytes: Buffer.byteLength(text, "utf8"),
      lineCount: 3,
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(source.reference).not.toContain("invented-call");
    expect(Object.keys(source).sort()).toEqual([
      "bytes",
      "lineCount",
      "reference",
      "sha256",
    ]);
    expect(read(store, { reference: source.reference })).toEqual({
      text,
      source,
      offset: 1,
      truncated: false,
    });
  });

  it.each([
    ["", 0],
    ["plain", 1],
    ["a\n", 1],
    ["a\r", 1],
    ["a\r\n", 1],
    ["\n", 1],
    ["\r", 1],
    ["\r\n", 1],
    ["\n\n", 2],
    ["a\r\nb\rc\nlast", 4],
    ["a\r\n\r\nb", 3],
    ["\n\u2028", 2],
    ["one\u2028two\u2029three", 1],
  ])(
    "preserves exact text %j with %i lines and no trailing phantom line",
    (text, count) => {
      const store = createContextOriginals();
      const source = capture(store, text);
      expect(source.lineCount).toBe(count);
      expect(read(store, { reference: source.reference }).text).toBe(text);
      expect(
        read(store, { reference: source.reference, byteOffset: 0 }).text,
      ).toBe(text);
    },
  );

  it("preserves mixed line endings across line pages", () => {
    const store = createContextOriginals();
    const source = capture(store, "a\r\nb\rc\nlast");
    const first = read(store, { reference: source.reference, limit: 2 });
    expect(first).toEqual({
      text: "a\r\nb\r",
      source,
      offset: 1,
      nextOffset: 3,
      truncated: true,
    });
    const second = read(store, {
      reference: source.reference,
      offset: first.nextOffset,
      limit: 2,
    });
    expect(second).toEqual({
      text: "c\nlast",
      source,
      offset: 3,
      truncated: false,
    });
    expect(first.text + second.text).toBe("a\r\nb\rc\nlast");
  });

  it("defaults to 100 lines and accepts at most 200", () => {
    const store = createContextOriginals();
    const lines = Array.from(
      { length: 205 },
      (_, index) => `line ${index + 1}\n`,
    );
    const source = capture(store, lines.join(""));
    const first = read(store, { reference: source.reference });
    expect(first.text).toBe(lines.slice(0, 100).join(""));
    expect(first.nextOffset).toBe(101);
    const maximum = read(store, { reference: source.reference, limit: 200 });
    expect(maximum.text).toBe(lines.slice(0, 200).join(""));
    expect(maximum.nextOffset).toBe(201);
    expect(store.read({ reference: source.reference, limit: 201 })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    expect(read(store, { reference: source.reference, offset: 205 }).text).toBe(
      lines[204],
    );
    expect(store.read({ reference: source.reference, offset: 206 })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
  });

  it("stops before a later line exceeds the byte budget and supplies its line offset", () => {
    const store = createContextOriginals();
    const line = `${"x".repeat(8191)}\r\n`;
    const source = capture(store, line + line + "tail");
    const first = read(store, { reference: source.reference });
    expect(first.text).toBe(line);
    expect(first.nextOffset).toBe(2);
    expect(first.nextByteOffset).toBeUndefined();
    const second = read(store, { reference: source.reference, offset: 2 });
    expect(second.text).toBe(line + "tail");
    expect(second.truncated).toBe(false);
  });

  it("retrieves every byte of a long single ASCII line through byte continuation", () => {
    const store = createContextOriginals();
    const text = "z".repeat(50_003);
    const source = capture(store, text);
    const first = read(store, { reference: source.reference });
    expect(first.offset).toBe(1);
    expect(first.byteOffset).toBe(0);
    expect(first.text).toBe(text.slice(0, 16_384));
    expect(first.nextByteOffset).toBe(16_384);
    expect(first.nextOffset).toBeUndefined();
    let result = first;
    let rebuilt = result.text;
    while (result.nextByteOffset !== undefined) {
      result = read(store, {
        reference: source.reference,
        byteOffset: result.nextByteOffset,
      });
      rebuilt += result.text;
      expect(result.offset).toBeUndefined();
    }
    expect(rebuilt).toBe(text);
    expect(result.truncated).toBe(false);
    expect(createHash("sha256").update(rebuilt, "utf8").digest("hex")).toBe(
      source.sha256,
    );
  });

  it("shortens UTF-8 byte pages instead of splitting an astral codepoint", () => {
    const store = createContextOriginals();
    const text = "x".repeat(16_383) + "😀" + "y".repeat(20);
    const source = capture(store, text);
    const first = read(store, { reference: source.reference, byteOffset: 0 });
    expect(first.text).toBe("x".repeat(16_383));
    expect(first.nextByteOffset).toBe(16_383);
    const second = read(store, {
      reference: source.reference,
      byteOffset: first.nextByteOffset,
    });
    expect(second.text).toBe("😀" + "y".repeat(20));
    expect(first.text + second.text).toBe(text);
    for (const byteOffset of [16_384, 16_385, 16_386]) {
      expect(store.read({ reference: source.reference, byteOffset })).toBe(
        CONTEXT_ORIGINALS_READ_ERROR,
      );
    }
  });

  it("reconstructs mixed Unicode and newline endings with byte pages", () => {
    const store = createContextOriginals();
    const text = "é\r\n😀\r中\n".repeat(7000) + "unterminated Ω";
    const source = capture(store, text);
    let next: number | undefined = 0;
    let rebuilt = "";
    while (next !== undefined) {
      const result = read(store, {
        reference: source.reference,
        byteOffset: next,
      });
      rebuilt += result.text;
      next = result.nextByteOffset;
      expect(result.text).not.toContain("\ufffd");
      expect(result.truncated).toBe(next !== undefined);
    }
    expect(rebuilt).toBe(text);
    expect(Buffer.from(rebuilt, "utf8")).toEqual(Buffer.from(text, "utf8"));
  });

  it("returns the absolute byte start for an oversized line after prior Unicode text", () => {
    const store = createContextOriginals();
    const prefix = "α\r\n";
    const longLine = "中".repeat(6000) + "\r\n";
    const suffix = "last\r";
    const source = capture(store, prefix + longLine + suffix);
    const first = read(store, {
      reference: source.reference,
      offset: 2,
      limit: 1,
    });
    expect(first.offset).toBe(2);
    expect(first.byteOffset).toBe(Buffer.byteLength(prefix, "utf8"));
    expect(Buffer.byteLength(first.text, "utf8")).toBe(16_383);
    expect(first.nextByteOffset).toBe(16_387);
    const rest = read(store, {
      reference: source.reference,
      byteOffset: first.nextByteOffset,
    });
    expect(first.text + rest.text).toBe(longLine + suffix);
  });

  it("retains CRLF exactly when a byte page ends between the pair", () => {
    const store = createContextOriginals();
    const text = "a".repeat(16_383) + "\r\nbare\r";
    const source = capture(store, text);
    const first = read(store, { reference: source.reference });
    expect(first.text.endsWith("\r")).toBe(true);
    const second = read(store, {
      reference: source.reference,
      byteOffset: first.nextByteOffset,
    });
    expect(second.text).toBe("\nbare\r");
    expect(first.text + second.text).toBe(text);
  });

  it("accepts byte EOF and empty-source reads but rejects offsets past EOF", () => {
    const store = createContextOriginals();
    const empty = capture(store, "");
    expect(read(store, { reference: empty.reference })).toEqual({
      text: "",
      source: empty,
      offset: 1,
      truncated: false,
    });
    expect(read(store, { reference: empty.reference, byteOffset: 0 })).toEqual({
      text: "",
      source: empty,
      byteOffset: 0,
      truncated: false,
    });
    expect(store.read({ reference: empty.reference, offset: 2 })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    const source = capture(store, "é", "nonempty");
    expect(
      read(store, { reference: source.reference, byteOffset: 2 }).text,
    ).toBe("");
    expect(store.read({ reference: source.reference, byteOffset: 3 })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
  });

  it("deduplicates exact content and identity even when quotas are full", () => {
    const store = createContextOriginals({ maxBytes: 3, maxSources: 1 });
    const first = capture(store, "abc", "call", 2);
    expect(capture(store, "abc", "call", 2)).toBe(first);
    expect(store.status()).toMatchObject({
      sourceCount: 1,
      bytes: 3,
      captures: 2,
      deduplicatedCaptures: 1,
      skippedCaptures: 0,
    });
  });

  it("keeps distinct content and identities distinct and leaves earlier sources readable", () => {
    const store = createContextOriginals();
    const sources = [
      capture(store, "same", "a", 0),
      capture(store, "same", "b", 0),
      capture(store, "same", "a", 1),
      capture(store, "changed", "a", 0),
    ];
    expect(new Set(sources.map((source) => source.reference)).size).toBe(4);
    expect(sources.slice(0, 3).map((source) => source.sha256)).toEqual([
      sources[0].sha256,
      sources[0].sha256,
      sources[0].sha256,
    ]);
    expect(read(store, { reference: sources[0].reference }).text).toBe("same");
    expect(read(store, { reference: sources[3].reference }).text).toBe(
      "changed",
    );
  });

  it("uses UTF-8 byte quotas without evicting live references", () => {
    const store = createContextOriginals({ maxBytes: 5, maxSources: 3 });
    const first = capture(store, "éé");
    expect(first.bytes).toBe(4);
    expect(
      store.capture({ toolCallId: "b", contentIndex: 0, text: "é" }),
    ).toBeUndefined();
    const second = capture(store, "x", "c");
    expect(store.status()).toMatchObject({
      sourceCount: 2,
      bytes: 5,
      skippedCaptures: 1,
    });
    expect(read(store, { reference: first.reference }).text).toBe("éé");
    expect(read(store, { reference: second.reference }).text).toBe("x");
  });

  it("applies a source quota even to empty originals", () => {
    const store = createContextOriginals({ maxBytes: 0, maxSources: 1 });
    const first = capture(store, "");
    expect(
      store.capture({ toolCallId: "other", contentIndex: 0, text: "" }),
    ).toBeUndefined();
    expect(store.status()).toMatchObject({
      sourceCount: 1,
      bytes: 0,
      skippedCaptures: 1,
    });
    expect(read(store, { reference: first.reference }).text).toBe("");
    expect(
      createContextOriginals({ maxSources: 0 }).capture({
        toolCallId: "call",
        contentIndex: 0,
        text: "",
      }),
    ).toBeUndefined();
  });

  it("caps each original at 16 MiB even if the aggregate quota is larger", () => {
    const store = createContextOriginals({
      maxBytes: CONTEXT_ORIGINALS_MAX_CAPTURE_BYTES * 2,
    });
    expect(
      store.capture({
        toolCallId: "oversized",
        contentIndex: 0,
        text: "x".repeat(CONTEXT_ORIGINALS_MAX_CAPTURE_BYTES + 1),
      }),
    ).toBeUndefined();
    expect(store.status().sourceCount).toBe(0);
  });

  it("does not retain or mutate caller records or canonical messages", () => {
    const store = createContextOriginals();
    const input = { toolCallId: "call", contentIndex: 0, text: "original\r\n" };
    const canonical = {
      role: "toolResult",
      content: [{ type: "text", text: input.text }],
    };
    const before = structuredClone(canonical);
    const source = store.capture(input)!;
    input.text = "changed";
    input.toolCallId = "changed-call";
    expect(read(store, { reference: source.reference }).text).toBe(
      "original\r\n",
    );
    expect(canonical).toEqual(before);
    expect(() => {
      (source as { bytes: number }).bytes = 999;
    }).toThrow(TypeError);
    const result = read(store, { reference: source.reference });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { text: string }).text = "forged";
    }).toThrow(TypeError);
    expect(read(store, { reference: source.reference }).source.bytes).toBe(10);
  });

  it("isolates store instances and invalidates every reference and metric on reset", () => {
    const store = createContextOriginals();
    store.reset("invented-session/branch-a");
    const source = capture(store, "private invented original");
    expect(createContextOriginals().read({ reference: source.reference })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    read(store, { reference: source.reference });
    store.read({ reference: "not-a-reference" });
    store.capture({ toolCallId: "call", contentIndex: -1, text: "rejected" });
    store.reset("invented-session/branch-b");
    expect(store.status()).toEqual({
      maxBytes: CONTEXT_ORIGINALS_DEFAULT_MAX_BYTES,
      maxSources: CONTEXT_ORIGINALS_DEFAULT_MAX_SOURCES,
      sourceCount: 0,
      bytes: 0,
      captures: 0,
      deduplicatedCaptures: 0,
      skippedCaptures: 0,
      reads: 0,
      readErrors: 0,
    });
    expect(store.read({ reference: source.reference })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    const replacement = capture(store, "private invented original");
    expect(replacement.reference).not.toBe(source.reference);
    store.reset("invented-session/branch-b");
    expect(store.read({ reference: replacement.reference })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
  });

  it("reports only frozen numeric statistics and never returns scope/text/identity", () => {
    const store = createContextOriginals();
    store.reset("do-not-disclose-scope");
    capture(store, "do-not-disclose-text", "do-not-disclose-call");
    const status = store.status();
    expect(
      Object.values(status).every((value) => typeof value === "number"),
    ).toBe(true);
    expect(Object.isFrozen(status)).toBe(true);
    expect(JSON.stringify(status)).not.toContain("do-not-disclose");
  });

  it.each([
    { offset: 0 },
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: "1" },
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: Infinity },
    { limit: "2" },
    { limit: undefined },
    { byteOffset: -1 },
    { byteOffset: 0.5 },
    { byteOffset: NaN },
    { byteOffset: Number.MAX_SAFE_INTEGER + 1 },
    { byteOffset: "0" },
    { byteOffset: undefined },
    { byteOffset: 0, offset: 1 },
    { byteOffset: 0, limit: 1 },
    { path: "/invented/arbitrary/path" },
  ])("returns the same safe error for invalid read fields %j", (fields) => {
    const store = createContextOriginals();
    const source = capture(store, "abc");
    const input = {
      reference: source.reference,
      ...fields,
    } as ContextOriginalReadRequest;
    expect(store.read(input)).toBe(CONTEXT_ORIGINALS_READ_ERROR);
  });

  it.each([
    "../invented",
    "/invented/file",
    "https://invalid.example/data",
    "",
    "ctxorig_bad",
  ])("does not resolve paths or foreign reference syntax %j", (reference) => {
    expect(createContextOriginals().read({ reference })).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
  });

  it("rejects a syntactically valid but never-issued reference with the same safe error", () => {
    expect(
      createContextOriginals().read({ reference: `ctxorig_${"0".repeat(48)}` }),
    ).toBe(CONTEXT_ORIGINALS_READ_ERROR);
    expect(Object.isFrozen(CONTEXT_ORIGINALS_READ_ERROR)).toBe(true);
    expect(Object.keys(CONTEXT_ORIGINALS_READ_ERROR)).toEqual(["error"]);
  });

  it.each([
    { toolCallId: "", contentIndex: 0, text: "a" },
    { toolCallId: 1, contentIndex: 0, text: "a" },
    { toolCallId: "a", contentIndex: -1, text: "a" },
    { toolCallId: "a", contentIndex: 0.5, text: "a" },
    { toolCallId: "a", contentIndex: "0", text: "a" },
    { toolCallId: "a", contentIndex: Number.MAX_SAFE_INTEGER + 1, text: "a" },
    { toolCallId: "a", contentIndex: 0, text: 12 },
    { toolCallId: "a", contentIndex: 0, text: "\ud800" },
    { toolCallId: "a", contentIndex: 0, text: "\udc00" },
    { toolCallId: "a", contentIndex: 0, text: "a", path: "invented" },
    { toolCallId: "é".repeat(513), contentIndex: 0, text: "a" },
  ])("skips malformed captures %j", (input) => {
    const store = createContextOriginals();
    expect(store.capture(input as ContextOriginalCapture)).toBeUndefined();
    expect(store.status()).toMatchObject({
      sourceCount: 0,
      bytes: 0,
      skippedCaptures: 1,
    });
  });

  it("accepts ordinary/null-prototype data records and rejects inherited fields and accessors", () => {
    const store = createContextOriginals(
      Object.assign(Object.create(null), { maxBytes: 100 }),
    );
    const input = Object.assign(Object.create(null), {
      toolCallId: "call",
      contentIndex: 0,
      text: "abc",
    });
    const source = store.capture(input)!;
    expect(
      read(
        store,
        Object.assign(Object.create(null), { reference: source.reference }),
      ).text,
    ).toBe("abc");
    const getter = vi.fn(() => source.reference);
    const request = {
      get reference() {
        return getter();
      },
    };
    expect(store.read(request)).toBe(CONTEXT_ORIGINALS_READ_ERROR);
    const captureGetter = vi.fn(() => "abc");
    expect(
      store.capture({
        toolCallId: "call",
        contentIndex: 1,
        get text() {
          return captureGetter();
        },
      }),
    ).toBeUndefined();
    expect(store.read(Object.create({ reference: source.reference }))).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    expect(store.capture(Object.create(input))).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(captureGetter).not.toHaveBeenCalled();
  });

  it("rejects accessors without consulting a polluted descriptor prototype", () => {
    const store = createContextOriginals();
    const source = capture(store, "invented original");
    const ownGetter = vi.fn(() => source.reference);
    const inheritedGetter = vi.fn(() => source.reference);
    const request = Object.defineProperty({}, "reference", {
      get: ownGetter,
      enumerable: true,
    });
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    let result;
    try {
      Object.defineProperty(Object.prototype, "value", {
        get: inheritedGetter,
        configurable: true,
      });
      result = store.read(request as ContextOriginalReadRequest);
    } finally {
      delete (Object.prototype as { value?: unknown }).value;
      if (previous) Object.defineProperty(Object.prototype, "value", previous);
    }
    expect(result).toBe(CONTEXT_ORIGINALS_READ_ERROR);
    expect(ownGetter).not.toHaveBeenCalled();
    expect(inheritedGetter).not.toHaveBeenCalled();
  });

  it("rejects proxies without executing traps, symbols, boxed values, arrays, and hidden fields", () => {
    const store = createContextOriginals();
    const source = capture(store, "abc");
    const trap = vi.fn(() => {
      throw new Error("Must not execute caller code");
    });
    const proxy = new Proxy(
      {},
      { get: trap, getPrototypeOf: trap, ownKeys: trap },
    );
    expect(store.read(proxy as ContextOriginalReadRequest)).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    expect(store.capture(proxy as ContextOriginalCapture)).toBeUndefined();
    expect(() =>
      createContextOriginals(proxy as ContextOriginalsOptions),
    ).toThrow("Invalid context-originals options");
    expect(trap).not.toHaveBeenCalled();
    const symbol = { reference: source.reference, [Symbol("invented")]: 1 };
    expect(store.read(symbol)).toBe(CONTEXT_ORIGINALS_READ_ERROR);
    expect(
      store.read({
        reference: new String(source.reference),
      } as unknown as ContextOriginalReadRequest),
    ).toBe(CONTEXT_ORIGINALS_READ_ERROR);
    expect(store.read([] as unknown as ContextOriginalReadRequest)).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    const hidden = Object.defineProperty({}, "reference", {
      value: source.reference,
    });
    expect(store.read(hidden as ContextOriginalReadRequest)).toBe(
      CONTEXT_ORIGINALS_READ_ERROR,
    );
    const conversion = vi.fn(() => 1);
    expect(
      store.read({
        reference: source.reference,
        offset: { valueOf: conversion },
      } as unknown as ContextOriginalReadRequest),
    ).toBe(CONTEXT_ORIGINALS_READ_ERROR);
    expect(conversion).not.toHaveBeenCalled();
  });

  it.each([
    { maxBytes: -1 },
    { maxBytes: Infinity },
    { maxBytes: 1.5 },
    { maxBytes: undefined },
    { maxSources: -1 },
    { maxSources: "2" },
    { maxSources: Number.MAX_SAFE_INTEGER + 1 },
    { unexpected: 1 },
    null,
  ])("rejects invalid quota options %j", (options) => {
    expect(() =>
      createContextOriginals(options as ContextOriginalsOptions),
    ).toThrow("Invalid context-originals options");
  });

  it("never invokes quota getters or scope conversion", () => {
    const getter = vi.fn(() => 1);
    expect(() =>
      createContextOriginals({
        get maxBytes() {
          return getter();
        },
      }),
    ).toThrow("Invalid context-originals options");
    expect(getter).not.toHaveBeenCalled();
    const conversion = vi.fn(() => "scope");
    expect(() =>
      createContextOriginals().reset({
        toString: conversion,
      } as unknown as string),
    ).toThrow("Invalid context-originals scope");
    expect(conversion).not.toHaveBeenCalled();
  });

  it("exports matching frozen retrieval schema limits", () => {
    expect(CONTEXT_ORIGINALS_READ_PARAMETERS.required).toEqual(["reference"]);
    expect(CONTEXT_ORIGINALS_READ_PARAMETERS.additionalProperties).toBe(false);
    expect(CONTEXT_ORIGINALS_READ_PARAMETERS.properties.limit.maximum).toBe(
      200,
    );
    expect(
      CONTEXT_ORIGINALS_READ_PARAMETERS.properties.byteOffset.minimum,
    ).toBe(0);
    expect(Object.isFrozen(CONTEXT_ORIGINALS_READ_PARAMETERS.properties)).toBe(
      true,
    );
  });
});
