import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createReadToolDefinition,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  LoadedRequestCache,
  LoadedRequestExecutionError,
  validateLoadedRequestBundle,
} from "../src/loaded-requests.js";
import { buildResponse, preparePrompt, type Request } from "../src/core.js";

const MODEL = "google/gemma-3-1b-it";
const BUILTIN = { source: "builtin", path: "<builtin:read>" };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const request = (
  state: unknown = "The build failed with a type mismatch.",
) => ({
  state,
  questions: [
    {
      id: "evidence",
      type: "score",
      instructions: "Rate evidence.",
      criteria: ["absent", "partial", "complete"],
    },
  ],
  options: { template_version: "v2" },
});
const bundle = () => ({
  records: [
    {
      id: "second",
      request: request({ command: "tsc --noEmit", exit_code: 2 }),
    },
    { id: "first", request: request("A build command failed.") },
  ],
});
function event(
  raw = JSON.stringify(bundle()),
  overrides: Record<string, unknown> = {},
): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "read-1",
    input: { path: "decision-bundle.json" },
    content: [{ type: "text", text: raw }],
    details: undefined,
    isError: false,
    ...overrides,
  } as ToolResultEvent;
}
function actualResponse(value: Request) {
  const plan = preparePrompt(value);
  return buildResponse(
    plan,
    Object.fromEntries(
      plan.questions.map((question) => [
        question.branch_id,
        Object.fromEntries(
          question.output_labels.map((label, index) => [
            label,
            index === 1 ? 10 : 0,
          ]),
        ),
      ]),
    ),
    23,
    true,
    {
      metadata: {
        model_revision: "fixture-google-gemma",
        artifact: { id: value.model, sha256: "a".repeat(64) },
      },
      metrics: { computed_prompt_tokens: 23, engine_forwards: 1 },
    },
  );
}

describe("loaded request read snapshots", () => {
  it("retains exact original read text/hash, injects only the configured model, and preserves record/question order", () => {
    const cache = new LoadedRequestCache();
    const input = bundle();
    const raw = JSON.stringify(input, null, 2) + "\n";
    const source = event(raw);
    const before = structuredClone(source);
    expect(cache.capture(source, BUILTIN)).toEqual({
      captured: true,
      source: {
        read_tool_call_id: "read-1",
        source_path: "decision-bundle.json",
        content_sha256: hash(raw),
        content_bytes: Buffer.byteLength(raw),
        record_ids: ["second", "first"],
      },
    });
    const loaded = cache.resolve("read-1", MODEL);
    expect(loaded.raw_content).toBe(raw);
    expect(loaded.records.map((record) => record.id)).toEqual([
      "second",
      "first",
    ]);
    expect(loaded.records[0].request).toMatchObject({
      ...input.records[0].request,
      model: MODEL,
    });
    expect(source).toEqual(before);
    expect(input.records[0].request).not.toHaveProperty("model");
    expect(
      cache.resolve("read-1", "google/gemma-3-4b-it").records[0].request.model,
    ).toBe("google/gemma-3-4b-it");
  });

  it("requires successful trusted builtin read tool_result events and a single original text block", () => {
    const cache = new LoadedRequestCache();
    for (const candidate of [
      event(undefined, { type: "tool_execution_end" }),
      event(undefined, { toolName: "bash" }),
      event(undefined, { isError: true }),
      event(undefined, { isError: undefined }),
      event(undefined, { content: [] }),
      event(undefined, {
        content: [{ type: "image", data: "fixture", mimeType: "image/png" }],
      }),
      event(undefined, {
        content: [
          { type: "text", text: JSON.stringify(bundle()) },
          { type: "text", text: "extra" },
        ],
      }),
      event(undefined, { details: { truncation: { truncated: true } } }),
      event(undefined, { details: {} }),
    ])
      expect(cache.capture(candidate, BUILTIN).captured).toBe(false);
    expect(cache.capture(event()).captured).toBe(false);
    expect(
      cache.capture(event(), { source: "extension", path: "<builtin:read>" })
        .captured,
    ).toBe(false);
    expect(
      cache.capture(event(), { source: "builtin", path: "<sdk:read>" })
        .captured,
    ).toBe(false);
    expect(cache.status.entries).toBe(0);
  });

  it("rejects supervision/model/additional fields at every wrapper boundary and malformed full JSON", () => {
    const cache = new LoadedRequestCache();
    const base = bundle();
    const candidates = [
      { ...base, targets: { evidence: { answer: 2 } } },
      { ...base, gold: "complete" },
      {
        records: [{ ...base.records[0], targets: { evidence: { answer: 2 } } }],
      },
      { records: [{ ...base.records[0], answer: 2 }] },
      { records: [{ id: "id", request: { ...request(), model: MODEL } }] },
      { records: [{ id: "id", request: { ...request(), targets: {} } }] },
      { records: [{ id: "id", request: { ...request(), tools: [] } }] },
      {
        records: [
          {
            id: "id",
            request: { ...request(), options: { template_version: "v3" } },
          },
        ],
      },
      { records: [base.records[0], base.records[0]] },
      { records: [{ id: "   ", request: request() }] },
      { records: [] },
    ];
    for (const candidate of candidates)
      expect(
        cache.capture(event(JSON.stringify(candidate)), BUILTIN).captured,
      ).toBe(false);
    for (const raw of [
      JSON.stringify(base).slice(0, -1),
      `\`\`\`json\n${JSON.stringify(base)}\n\`\`\``,
      `${JSON.stringify(base)}\n[2 more lines in file. Use offset=2 to continue.]`,
      `{"records":[],"records":${JSON.stringify(base.records)}}`,
      JSON.stringify(base).replace('"state":', '"state":"first","state":'),
    ])
      expect(cache.capture(event(raw), BUILTIN).captured).toBe(false);
    expect(cache.status.entries).toBe(0);
  });

  it("rejects actual pi suffix and user-limited reads even when details are undefined", async () => {
    const raw = JSON.stringify(bundle());
    const operations = {
      access: vi.fn(async () => {}),
      readFile: vi.fn(async () => Buffer.from(`excluded prefix\n${raw}`)),
    };
    const definition = createReadToolDefinition("/virtual", { operations });
    const partial = await definition.execute("suffix", {
      path: "bundle.json",
      offset: 2,
    });
    expect(partial.details).toBeUndefined();
    expect(partial.content).toEqual([{ type: "text", text: raw }]);
    const cache = new LoadedRequestCache();
    expect(
      cache.capture(
        event(raw, {
          toolCallId: "suffix",
          input: { path: "bundle.json", offset: 2 },
          content: partial.content,
          details: partial.details,
        }),
        BUILTIN,
      ).captured,
    ).toBe(false);
    operations.readFile.mockImplementation(async () =>
      Buffer.from(`${raw}\nexcluded suffix`),
    );
    const limited = await definition.execute("limited", {
      path: "bundle.json",
      limit: 1,
    });
    expect(limited.details).toBeUndefined();
    expect(
      cache.capture(
        event(raw, {
          toolCallId: "limited",
          input: { path: "bundle.json", limit: 1 },
          content: limited.content,
          details: limited.details,
        }),
        BUILTIN,
      ).captured,
    ).toBe(false);
    for (const offset of [0, -1, 0.5, 2])
      expect(
        cache.capture(
          event(raw, { input: { path: "bundle.json", offset } }),
          BUILTIN,
        ).captured,
      ).toBe(false);
    expect(
      cache.capture(
        event(raw, { input: { path: "bundle.json", offset: 1 } }),
        BUILTIN,
      ).captured,
    ).toBe(true);
  });

  it("makes identical call capture idempotent, rejects ID rebinding, and supersedes a reread of changed evidence", () => {
    const cache = new LoadedRequestCache();
    const original = event();
    expect(cache.capture(original, BUILTIN).captured).toBe(true);
    expect(cache.capture(original, BUILTIN).captured).toBe(true);
    expect(cache.status.entries).toBe(1);
    const changed = JSON.stringify({
      records: [
        { id: "changed", request: request("Updated failure evidence.") },
      ],
    });
    expect(cache.capture(event(changed), BUILTIN)).toEqual({
      captured: false,
      reason: "read_tool_call_id_collision",
    });
    expect(() => cache.resolve("read-1", MODEL)).toThrow("absent");
    expect(cache.capture(original, BUILTIN).captured).toBe(true);
    expect(
      cache.capture(event(changed, { toolCallId: "read-2" }), BUILTIN).captured,
    ).toBe(true);
    expect(() => cache.resolve("read-1", MODEL)).toThrow("superseded");
    expect(cache.resolve("read-2", MODEL).records[0].request.state).toBe(
      "Updated failure evidence.",
    );
    expect(() => cache.resolve("decision-bundle.json", MODEL)).toThrow(
      "absent",
    );
    expect(
      cache.capture(
        event("invalid changed document", { toolCallId: "read-3" }),
        BUILTIN,
      ).captured,
    ).toBe(false);
    expect(() => cache.resolve("read-2", MODEL)).toThrow("absent");
    cache.capture(original, BUILTIN);
    expect(
      cache.capture(
        event(undefined, { input: { path: "decision-bundle.json", limit: 1 } }),
        BUILTIN,
      ).captured,
    ).toBe(false);
    expect(() => cache.resolve("read-1", MODEL)).toThrow("absent");
  });

  it("enforces record/read/total-byte bounds and deterministic FIFO entry eviction", () => {
    const raw = JSON.stringify(bundle());
    const bytes = Buffer.byteLength(raw);
    const cache = new LoadedRequestCache({
      maxEntries: 2,
      maxBytes: bytes * 2,
    });
    for (let i = 1; i <= 3; i++)
      expect(
        cache.capture(
          event(raw, {
            toolCallId: `read-${i}`,
            input: { path: `bundle-${i}.json` },
          }),
          BUILTIN,
        ).captured,
      ).toBe(true);
    expect(cache.status).toMatchObject({ entries: 2, bytes: bytes * 2 });
    expect(() => cache.resolve("read-1", MODEL)).toThrow("evicted");
    expect(cache.resolve("read-2", MODEL).records).toHaveLength(2);
    const byteBound = new LoadedRequestCache({
      maxEntries: 8,
      maxBytes: bytes + 1,
    });
    byteBound.capture(event(raw), BUILTIN);
    byteBound.capture(
      event(raw, { toolCallId: "new", input: { path: "other.json" } }),
      BUILTIN,
    );
    expect(byteBound.status).toMatchObject({ entries: 1, bytes });
    expect(
      new LoadedRequestCache({ maxRecords: 1 }).capture(event(raw), BUILTIN)
        .captured,
    ).toBe(false);
    expect(
      new LoadedRequestCache({ maxReadBytes: bytes - 1 }).capture(
        event(raw),
        BUILTIN,
      ).captured,
    ).toBe(false);
    expect(() => new LoadedRequestCache({ maxEntries: 0 })).toThrow(
      "maxEntries",
    );
    expect(() => new LoadedRequestCache({ maxRecords: 257 })).toThrow(
      "maxRecords",
    );
  });

  it("rejects accessors and non-plain request values before invoking them", () => {
    const getter = vi.fn(() => "secret");
    const evidence = Object.defineProperty({}, "message", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      validateLoadedRequestBundle(
        { records: [{ id: "one", request: request(evidence) }] },
        MODEL,
      ),
    ).toThrow("accessors");
    const wrapper = Object.defineProperty({}, "records", {
      enumerable: true,
      get: getter,
    });
    expect(() => validateLoadedRequestBundle(wrapper, MODEL)).toThrow(
      "accessors",
    );
    expect(() =>
      validateLoadedRequestBundle(
        { records: [{ id: "one", request: request(new Date()) }] },
        MODEL,
      ),
    ).toThrow("plain");
    const cache = new LoadedRequestCache();
    const unsafe = Object.defineProperty(event(), "content", {
      enumerable: true,
      get: getter,
    });
    expect(cache.capture(unsafe, BUILTIN).captured).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const sparse = Array(2);
    sparse[1] = bundle().records[0];
    expect(() =>
      validateLoadedRequestBundle({ records: sparse }, MODEL),
    ).toThrow("dense");
  });

  it("isolates capture/resolve mutations and resets reference ownership on session clear", () => {
    const cache = new LoadedRequestCache();
    const source = event();
    const captured = cache.capture(source, BUILTIN);
    if (captured.captured) captured.source.record_ids.reverse();
    (source.content[0] as any).text = "changed externally";
    const loaded = cache.resolve("read-1", MODEL);
    loaded.records[0].request.state = "changed resolved clone";
    loaded.source.record_ids.reverse();
    expect(cache.resolve("read-1", MODEL).records[0].request.state).toEqual({
      command: "tsc --noEmit",
      exit_code: 2,
    });
    expect(cache.resolve("read-1", MODEL).source.record_ids).toEqual([
      "second",
      "first",
    ]);
    cache.clear();
    expect(cache.status).toEqual({
      entries: 0,
      bytes: 0,
      session_generation: 1,
    });
    expect(() => cache.resolve("read-1", MODEL)).toThrow("absent");
  });
});

describe("loaded sequential classification", () => {
  it("calls the supplied classifier in exact order with signal/model and retains full actual responses without mutation", async () => {
    const cache = new LoadedRequestCache();
    cache.capture(event(), BUILTIN);
    const source = cache.resolve("read-1", MODEL);
    const controller = new AbortController();
    const responses: ReturnType<typeof actualResponse>[] = [];
    const classify = vi.fn(async (value: Request, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      const response = actualResponse(value);
      responses.push(response);
      value.state = "callback-mutated clone";
      return response;
    });
    const receipt = await cache.classify(
      "read-1",
      MODEL,
      classify,
      controller.signal,
    );
    expect(receipt.results.map((result) => result.id)).toEqual([
      "second",
      "first",
    ]);
    expect(receipt.results.map((result) => result.request_sha256)).toEqual(
      source.records.map((record) => hash(JSON.stringify(record.request))),
    );
    expect(receipt.results.map((result) => result.response)).toEqual(responses);
    expect(receipt.results[0].response.metrics).toMatchObject({
      engine_forwards: 1,
    });
    responses[0].answers.evidence = { type: "noul", noul: 0.5 };
    expect(receipt.results[0].response.answers.evidence.type).toBe("score");
    expect(cache.resolve("read-1", MODEL).records).toEqual(source.records);
    expect(receipt).not.toHaveProperty("approved");
    expect(receipt).not.toHaveProperty("correct");
  });

  it("retains completed responses on a later failure and never classifies later records", async () => {
    const cache = new LoadedRequestCache();
    const input = bundle();
    input.records.push({ id: "third", request: request("Later evidence.") });
    cache.capture(event(JSON.stringify(input)), BUILTIN);
    const classify = vi.fn(async (value: Request) => {
      if (typeof value.state === "string")
        throw new Error("native fixture failure");
      return actualResponse(value);
    });
    const error = await cache
      .classify("read-1", MODEL, classify)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(LoadedRequestExecutionError);
    expect(error.kind).toBe("classification_failed");
    expect(error.receipt.results).toHaveLength(1);
    expect(error.receipt.results[0].response.model).toBe(MODEL);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("honors already-aborted and between-record cancellation without returning invented partial answers", async () => {
    const cache = new LoadedRequestCache();
    cache.capture(event(), BUILTIN);
    const aborted = new AbortController();
    aborted.abort(new Error("caller cancelled"));
    const never = vi.fn(async (value: Request) => actualResponse(value));
    await expect(
      cache.classify("read-1", MODEL, never, aborted.signal),
    ).rejects.toMatchObject({ kind: "aborted", receipt: { results: [] } });
    expect(never).not.toHaveBeenCalled();
    const controller = new AbortController();
    const classify = vi.fn(async (value: Request) => {
      const response = actualResponse(value);
      queueMicrotask(() => controller.abort(new Error("cancel after result")));
      return response;
    });
    const error = await cache
      .classify("read-1", MODEL, classify, controller.signal)
      .catch((caught) => caught);
    expect(error.kind).toBe("aborted");
    expect(error.receipt.results).toHaveLength(0);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("aborts the supplied callback signal and rejects stale work when the session is cleared", async () => {
    const cache = new LoadedRequestCache();
    cache.capture(event(), BUILTIN);
    let finish!: () => void;
    let observed!: AbortSignal;
    const classify = vi.fn(async (value: Request, signal?: AbortSignal) => {
      observed = signal!;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return actualResponse(value);
    });
    const pending = cache.classify("read-1", MODEL, classify);
    const rejected = expect(pending).rejects.toMatchObject({
      kind: "session_cleared",
      receipt: { results: [] },
    });
    expect(finish).toBeTypeOf("function");
    cache.clear();
    expect(observed.aborted).toBe(true);
    finish();
    await rejected;
    expect(classify).toHaveBeenCalledTimes(1);
    expect(cache.status.entries).toBe(0);
  });
});
