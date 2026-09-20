import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayTransport,
  GatewayTransportError,
  parseStrictJsonObject,
  type GatewayChatRequest,
  type GatewayErrorCode,
  type GatewayTransportOptions,
} from "../src/gateway.js";

// Every request, response, identity, and credential in this file is invented.
// Every transport supplies fetch explicitly; no native fetch or config is read.
const baseUrl = "https://synthetic-gateway.invalid/v1";
const model = "grok-4.6";
const apiKey = "INVENTED_KEY_NEVER_SENT_TO_NETWORK";
const request: GatewayChatRequest = {
  messages: [{ role: "user", content: "Invented CPU task" }],
  maxTokens: 2048,
};
const counters = {
  prompt_tokens: 30,
  completion_tokens: 5,
  total_tokens: 35,
  prompt_tokens_details: { cached_tokens: 12 },
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    model,
    choices: [
      {
        message: { role: "assistant", content: '{"value":7}' },
        finish_reason: "stop",
      },
    ],
    usage: counters,
    ...overrides,
  };
}

function transport(
  fetch: typeof globalThis.fetch,
  options: Partial<GatewayTransportOptions> = {},
) {
  return createGatewayTransport({ baseUrl, model, apiKey, ...options, fetch });
}

const responseFetch = (body: string, init?: ResponseInit) =>
  vi.fn(
    async () => new Response(body, init),
  ) as unknown as typeof globalThis.fetch;
const objectFetch = (body: Record<string, unknown>) =>
  responseFetch(JSON.stringify(body));

async function failure(work: Promise<unknown>, code: GatewayErrorCode) {
  let received: unknown;
  try {
    await work;
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(GatewayTransportError);
  const error = received as GatewayTransportError;
  expect(error.code).toBe(code);
  expect(error).not.toHaveProperty("cause");
  expect(String(error) + JSON.stringify(error)).not.toContain(apiKey);
  return error;
}

describe("bounded text-only gateway transport", () => {
  it("sends the exact configured model/endpoint, omits temperature, and keeps options and extra fields private", async () => {
    const raw = JSON.stringify(
      envelope({ private_server_field: "RAW_BODY_MARKER" }),
    );
    const fetch = responseFetch(raw);
    const gateway = transport(fetch, { baseUrl: `${baseUrl}/` });
    const observed = await gateway.chat({
      ...request,
      messages: [{ ...request.messages[0], apiKey } as any],
      apiKey,
      temperature: 0,
    } as GatewayChatRequest);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${baseUrl}/chat/completions`);
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toEqual({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      model,
      messages: request.messages,
      max_tokens: 2048,
      stream: false,
    });
    expect(options?.body).not.toContain(apiKey);
    expect(observed).toEqual({
      assistantText: '{"value":7}',
      finishReason: "stop",
      usage: {
        promptTokens: 30,
        completionTokens: 5,
        totalTokens: 35,
        cachedPromptTokens: 12,
      },
      elapsedMs: expect.any(Number),
      responseSha256: createHash("sha256").update(raw).digest("hex"),
    });
    expect(observed.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(gateway)).toBe("{}");
    expect(JSON.stringify(observed)).not.toContain("RAW_BODY_MARKER");
  });

  it("decodes split UTF-8 and hashes exact raw bytes, accepting the exact byte limit", async () => {
    const raw = JSON.stringify(
      envelope({
        choices: [
          {
            message: { role: "assistant", content: "café" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const bytes = Buffer.from(raw);
    const split = bytes.indexOf(0xc3) + 1;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, split));
              controller.enqueue(bytes.subarray(split));
              controller.close();
            },
          }),
        ),
    ) as unknown as typeof globalThis.fetch;
    const observed = await transport(fetch, {
      maxResponseBytes: bytes.byteLength,
    }).chat(request);
    expect(observed.assistantText).toBe("café");
    expect(observed.responseSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("cancels an oversized multibyte stream during reading, without trusting Content-Length", async () => {
    const cancel = vi.fn();
    let emitted = 0;
    const chunk = new TextEncoder().encode("é".repeat(12));
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              emitted++;
              controller.enqueue(chunk);
            },
            cancel,
          }),
          { headers: { "content-length": "1" } },
        ),
    ) as unknown as typeof globalThis.fetch;
    const error = await failure(
      transport(fetch, { maxResponseBytes: 32 }).chat(request),
      "response_too_large",
    );
    expect(error.httpStatus).toBe(200);
    expect(error.usage).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(emitted).toBeLessThanOrEqual(3);
  });

  it("times out a fetch that ignores its abort signal", async () => {
    let internalSignal: AbortSignal | undefined;
    const fetch = vi.fn((_, options) => {
      internalSignal = options?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }) as typeof globalThis.fetch;
    const error = await failure(
      transport(fetch, { timeoutMs: 15 }).chat(request),
      "timeout",
    );
    expect(internalSignal?.aborted).toBe(true);
    expect(error.usage).toBeNull();
    expect(error.elapsedMs).toBeGreaterThanOrEqual(14);
  });

  it("times out a stalled body and settles even when cancellation never resolves", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetch = vi.fn(
      async () => new Response(new ReadableStream({ pull() {}, cancel })),
    ) as unknown as typeof globalThis.fetch;
    const error = await failure(
      transport(fetch, { timeoutMs: 15 }).chat(request),
      "timeout",
    );
    expect(error.httpStatus).toBe(200);
    expect(error.usage).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("combines external abort with timeout without retaining the caller's abort reason", async () => {
    const controller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    const fetch = vi.fn((_, options) => {
      internalSignal = options?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }) as typeof globalThis.fetch;
    const pending = transport(fetch).chat({
      ...request,
      signal: controller.signal,
    });
    controller.abort(`CALLER_PRIVATE_REASON ${apiKey}`);
    const error = await failure(pending, "aborted");
    expect(internalSignal?.aborted).toBe(true);
    expect(JSON.stringify(error) + String(error)).not.toContain(
      "CALLER_PRIVATE_REASON",
    );
  });

  it("does not fetch a request whose external signal was already aborted", async () => {
    const fetch = objectFetch(envelope());
    const signal = AbortSignal.abort(`CALLER_PRIVATE_REASON ${apiKey}`);
    await failure(transport(fetch).chat({ ...request, signal }), "aborted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a late response after timeout instead of leaving its body unread", async () => {
    const cancel = vi.fn();
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ) as typeof globalThis.fetch;
    await failure(transport(fetch, { timeoutMs: 15 }).chat(request), "timeout");
    resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reports HTTP failures as unknown usage and never retains the error body", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(`PRIVATE_HTTP_BODY ${apiKey}`));
            },
            cancel,
          }),
          { status: 401 },
        ),
    ) as unknown as typeof globalThis.fetch;
    const error = await failure(transport(fetch).chat(request), "http_error");
    expect(error.httpStatus).toBe(401);
    expect(error.usage).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error) + String(error)).not.toContain(
      "PRIVATE_HTTP_BODY",
    );
  });

  it("replaces arbitrary fetch errors with a fixed safe code", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`PRIVATE_NETWORK_DETAIL ${apiKey}`);
    }) as typeof globalThis.fetch;
    const error = await failure(
      transport(fetch).chat(request),
      "network_error",
    );
    expect(error.httpStatus).toBeNull();
    expect(error.usage).toBeNull();
    expect(String(error)).not.toContain("PRIVATE_NETWORK_DETAIL");
  });

  it("replaces stream failures with a fixed safe code", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new Error(`PRIVATE_STREAM_DETAIL ${apiKey}`);
            },
          }),
        ),
    ) as unknown as typeof globalThis.fetch;
    const error = await failure(
      transport(fetch).chat(request),
      "network_error",
    );
    expect(error.httpStatus).toBe(200);
    expect(error.usage).toBeNull();
    expect(String(error) + JSON.stringify(error)).not.toContain(
      "PRIVATE_STREAM_DETAIL",
    );
  });

  it("does not propagate exceptions raised while reading configuration or request properties", async () => {
    const fetch = objectFetch(envelope());
    const options = {
      baseUrl,
      apiKey,
      fetch,
      get model(): string {
        throw new Error(`PRIVATE_GETTER_DETAIL ${apiKey}`);
      },
    };
    expect(() => createGatewayTransport(options)).toThrowError(
      "Gateway configuration is invalid",
    );
    const invalidRequest = {
      maxTokens: 2048,
      get messages(): GatewayChatRequest["messages"] {
        throw new Error(`PRIVATE_GETTER_DETAIL ${apiKey}`);
      },
    };
    const error = await failure(
      transport(fetch).chat(invalidRequest),
      "invalid_request",
    );
    expect(String(error) + JSON.stringify(error)).not.toContain(
      "PRIVATE_GETTER_DETAIL",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.invalid/v1/chat/completions",
    `${baseUrl}/wrong-path`,
    "redirected",
  ])("rejects an unexpected response destination %s", async (destination) => {
    const response = new Response(JSON.stringify(envelope()));
    Object.defineProperty(
      response,
      destination === "redirected" ? "redirected" : "url",
      {
        value: destination === "redirected" ? true : destination,
      },
    );
    const fetch = vi.fn(async () => response) as typeof globalThis.fetch;
    const error = await failure(
      transport(fetch).chat(request),
      "protocol_error",
    );
    expect(error.usage).toBeNull();
  });

  it.each([
    "http://synthetic-gateway.invalid/v1",
    "/v1",
    "https://user:secret@synthetic-gateway.invalid/v1",
    `${baseUrl}?secret=PRIVATE_QUERY`,
    `${baseUrl}#secret`,
    `${baseUrl}?`,
    `${baseUrl}#`,
    `${baseUrl}\\other`,
    ` ${baseUrl}`,
    `${baseUrl} `,
  ])("rejects unsafe base URL %s without exposing it", (unsafeBase) => {
    const fetch = objectFetch(envelope());
    expect(() => transport(fetch, { baseUrl: unsafeBase })).toThrowError(
      "Gateway configuration is invalid",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { model: "" },
    { model: "grok 4.6" },
    { apiKey: "" },
    { apiKey: "secret\nvalue" },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 },
  ])("rejects invalid configuration %j", (options) => {
    const fetch = objectFetch(envelope());
    expect(() => transport(fetch, options)).toThrowError(GatewayTransportError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...request, maxTokens: 0 },
    { ...request, maxTokens: 1.5 },
    { ...request, messages: [] },
    { ...request, messages: Array(2) },
    { ...request, messages: [{ role: "tool", content: "unsupported" }] },
    { ...request, messages: [{ role: "user", content: "\ud800" }] },
  ])("rejects malformed requests before fetching", async (invalidRequest) => {
    const fetch = objectFetch(envelope());
    await failure(
      transport(fetch).chat(invalidRequest as GatewayChatRequest),
      "invalid_request",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { choices: [] },
    { choices: [envelope().choices[0], envelope().choices[0]] },
    {
      choices: [
        {
          message: { role: "user", content: "wrong role" },
          finish_reason: "stop",
        },
      ],
    },
    {
      choices: [
        { message: { role: "assistant", content: [] }, finish_reason: "stop" },
      ],
    },
    {
      choices: [
        { message: { role: "assistant", content: "" }, finish_reason: "stop" },
      ],
    },
    {
      choices: [
        {
          message: { role: "assistant", content: " \n " },
          finish_reason: "stop",
        },
      ],
    },
    {
      choices: [
        {
          index: 1,
          message: { role: "assistant", content: "text" },
          finish_reason: "stop",
        },
      ],
    },
    {
      choices: [
        {
          message: { role: "assistant", content: "\ud800" },
          finish_reason: "stop",
        },
      ],
    },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "text",
            refusal: "PRIVATE_REFUSAL",
          },
          finish_reason: "stop",
        },
      ],
    },
    {
      choices: [
        {
          message: { role: "assistant", content: "text", tool_calls: [{}] },
          finish_reason: "stop",
        },
      ],
    },
    { choices: [{ message: { role: "assistant", content: "text" } }] },
    {
      choices: [
        {
          message: { role: "assistant", content: "text" },
          finish_reason: "unknown",
        },
      ],
    },
    { model: "other-model" },
  ])(
    "rejects ambiguous or unsupported response protocols",
    async (overrides) => {
      const error = await failure(
        transport(objectFetch(envelope(overrides))).chat(request),
        "protocol_error",
      );
      expect(error.usage).toBeNull();
      expect(String(error) + JSON.stringify(error)).not.toContain(
        "PRIVATE_REFUSAL",
      );
    },
  );

  it.each(["length", "content_filter"])(
    "rejects %s completions but retains validated observed usage",
    async (reason) => {
      const response = envelope({
        choices: [
          {
            message: { role: "assistant", content: '{"value":7}' },
            finish_reason: reason,
          },
        ],
      });
      const error = await failure(
        transport(objectFetch(response)).chat(request),
        "incomplete_completion",
      );
      expect(error.usage).toEqual({
        promptTokens: 30,
        completionTokens: 5,
        totalTokens: 35,
        cachedPromptTokens: 12,
      });
    },
  );

  it.each([
    '{"apiKey":PRIVATE_RESPONSE_SOURCE}',
    '{"choices":[],"choices":[]}',
    new Uint8Array([0xff]),
  ])(
    "rejects malformed/duplicate JSON and invalid UTF-8 without source excerpts",
    async (body) => {
      const fetch = vi.fn(
        async () => new Response(body),
      ) as typeof globalThis.fetch;
      const error = await failure(
        transport(fetch).chat(request),
        "protocol_error",
      );
      expect(error.usage).toBeNull();
      expect(String(error) + JSON.stringify(error)).not.toMatch(
        /PRIVATE_RESPONSE_SOURCE|apiKey|Unexpected token/,
      );
    },
  );

  it.each([undefined, null, {}])(
    "preserves absent usage as null counters",
    async (usage) => {
      const observed = await transport(objectFetch(envelope({ usage }))).chat(
        request,
      );
      expect(observed.usage).toEqual({
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedPromptTokens: null,
      });
    },
  );

  it("does not infer missing counters and distinguishes known zero from unknown cache usage", async () => {
    const partial = await transport(
      objectFetch(envelope({ usage: { prompt_tokens: 30, total_tokens: 35 } })),
    ).chat(request);
    expect(partial.usage).toEqual({
      promptTokens: 30,
      completionTokens: null,
      totalTokens: 35,
      cachedPromptTokens: null,
    });
    const zero = await transport(
      objectFetch(
        envelope({
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      ),
    ).chat(request);
    expect(zero.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedPromptTokens: 0,
    });
  });

  it.each([
    { prompt_tokens: -1 },
    { prompt_tokens: 0.5 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { prompt_tokens: "30" },
    { ...counters, total_tokens: 36 },
    { ...counters, total_tokens: 29 },
    { completion_tokens: 5, total_tokens: 4 },
    { ...counters, prompt_tokens_details: { cached_tokens: 31 } },
    { total_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
    { ...counters, prompt_tokens_details: "invalid" },
    [],
    {
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: 1,
      total_tokens: Number.MAX_SAFE_INTEGER,
    },
  ])("rejects malformed or inconsistent usage as unknown", async (usage) => {
    const error = await failure(
      transport(objectFetch(envelope({ usage }))).chat(request),
      "protocol_error",
    );
    expect(error.usage).toBeNull();
  });
});

describe("strict JSON object parsing", () => {
  it("accepts bare objects with whitespace, escapes, and keys repeated only in different objects", () => {
    const original = {
      left: { key: 1 },
      right: { key: 2 },
      values: [{ key: 3 }, { key: 4 }],
      text: 'literal { "key": 5 } and quote " \\',
    };
    expect(parseStrictJsonObject(` \n${JSON.stringify(original)}\n `)).toEqual(
      original,
    );
  });

  it.each([
    '{"key":1,"key":2}',
    '{"key":1,"\\u006bey":2}',
    '{"nested":{"key":1,"key":2}}',
    '{"array":[{"key":1,"key":2}]}',
  ])("rejects duplicate decoded keys at every object scope", (source) => {
    expect(() => parseStrictJsonObject(source)).toThrowError(
      "Gateway JSON object has duplicate keys",
    );
  });

  it.each([
    '```json\n{"key":1}\n```',
    '[{"key":1}]',
    "null",
    '{"key":1e1000}',
    '{"key":"\\ud800"}',
    '{"\\ud800":1}',
    '{"key":PRIVATE_SOURCE}',
  ])("rejects unsupported JSON with fixed source-free errors", (source) => {
    let error: unknown;
    try {
      parseStrictJsonObject(source);
    } catch (received) {
      error = received;
    }
    expect(error).toBeInstanceOf(GatewayTransportError);
    expect((error as GatewayTransportError).code).toBe("invalid_json_object");
    expect(String(error) + JSON.stringify(error)).not.toMatch(
      /PRIVATE_SOURCE|Unexpected token/,
    );
  });

  it("handles a valid large array without spreading it onto the JS call stack", () => {
    const value = { extra: Array(200_000).fill(0) };
    expect(parseStrictJsonObject(JSON.stringify(value))).toEqual(value);
  });

  it("rejects node/depth limits with the same safe error type", () => {
    expect(() =>
      parseStrictJsonObject(
        JSON.stringify({ extra: Array(1_000_000).fill(0) }),
      ),
    ).toThrowError(GatewayTransportError);
    const deep = '{"nested":'.repeat(129) + "null" + "}".repeat(129);
    expect(() => parseStrictJsonObject(deep)).toThrowError(
      "Gateway JSON object is invalid",
    );
  });
});
