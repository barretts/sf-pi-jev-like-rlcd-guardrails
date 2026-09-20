import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowClassifier,
  WORKFLOW_CLASSIFIER_LIMITS,
  type WorkflowClassifierArtifact,
  type WorkflowClassifierOptions,
} from "../src/workflow-classifier.js";
import {
  routingFeatureProvenance,
  type RoutingRuntimeOptions,
  type RoutingRuntimeResult,
} from "../src/routing-runtime.js";
import type {
  RoutingContext,
  RoutingQualification,
} from "../src/routing-extension.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// Invented CPU-only head metadata. No learned artifact, feature cache, corpus,
// worker process, or model execution is used by these injected-runtime tests.
const headJson = JSON.stringify({
  version: 1,
  dimension: 1152,
  weights: Array(1152).fill(0),
  bias: -8,
  featureCenter: Array(1152).fill(0),
  featureScale: Array(1152).fill(1),
  threshold: 0.5,
  minMargin: 0.1,
  calibration: "uncalibrated",
  trainingDiagnostics: {
    optimizer: "lbfgs",
    objective: "mean_logistic_loss_plus_l2_weights",
    rowCount: 2,
    classCounts: { fast: 1, strong: 1 },
    standardize: false,
    l2: 0.1,
    maxIterations: 1,
    iterations: 0,
    initialLoss: 0.7,
    loss: 0.5,
    dataLoss: 0.5,
    regularizationLoss: 0,
    fullGradient: Array(1153).fill(0),
    gradientNorm: 0,
    gradientInfinityNorm: 0,
    stationarityTolerance: 1e-7,
    stationary: true,
    termination: "stationary",
  },
});
const artifact: WorkflowClassifierArtifact = {
  schemaVersion: 1,
  artifactId: "invented-cpu-routing-head",
  headJson,
  headSha256: digest(headJson),
  python: "/synthetic-cpu/python",
  workerPath: "/synthetic-cpu/worker.py",
  workerSha256: "d".repeat(64),
  qualificationSha256: "e".repeat(64),
};
type Message = RoutingContext["messages"][number];
const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 1,
});
const assistant = (value: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: value }],
  timestamp: 2,
  api: "openai-completions",
  provider: "invented-cpu",
  model: "invented-cpu",
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const tool = (toolCallId: string, value: string, isError = false): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "invented-read",
  content: [{ type: "text", text: value }],
  isError,
  timestamp: 3,
});
const context = (...messages: Message[]): RoutingContext => ({ messages });
const request = () => context(user("What is 8 + 11? Return only the integer."));

function setup(overrides: Partial<WorkflowClassifierOptions> = {}) {
  let pins!: RoutingRuntimeOptions;
  const classify = vi.fn(
    async (
      input: { text: string; essentialFactsAvailable?: boolean },
      signal?: AbortSignal,
    ): Promise<RoutingRuntimeResult> => {
      if (signal?.aborted) throw new Error("invented-cpu-aborted");
      const verified = input.essentialFactsAvailable === true;
      return {
        decision: verified ? "fast" : "strong",
        confidence: verified ? 0.98 : 0,
        calibration: "uncalibrated",
        reason: verified ? "head-score" : "essential-facts-not-verified",
        fastScore: verified ? 0.98 : null,
        strongScore: verified ? 0.02 : null,
        artifactId: pins.artifactId,
        artifactSha256: pins.artifactSha256,
        qualificationSha256: pins.qualificationSha256,
        workerSha256: pins.workerSha256,
        inputTokens: verified ? 17 : 0,
        featureElapsedMs: verified ? 2 : 0,
        operationalElapsedMs: verified ? 4 : 0,
        provenance: verified
          ? routingFeatureProvenance(pins.workerSha256)
          : null,
      };
    },
  );
  const dispose = vi.fn(async () => {});
  const createRuntime = vi.fn((options: RoutingRuntimeOptions) => {
    pins = options;
    return { classify, dispose };
  });
  const selected = overrides.artifact ?? artifact;
  const artifactJson =
    overrides.artifactJson ?? `${JSON.stringify(selected, null, 2)}\n`;
  const artifactSha256 = overrides.artifactSha256 ?? digest(artifactJson);
  const instance = createWorkflowClassifier({
    artifact: selected,
    artifactJson,
    artifactSha256,
    createRuntime,
    ...overrides,
  });
  const qualification: RoutingQualification = {
    qualified: true,
    artifactId: artifact.artifactId,
    artifactSha256,
    qualificationSha256: artifact.qualificationSha256,
  };
  return {
    instance,
    classify,
    dispose,
    createRuntime,
    qualification,
    artifactJson,
    artifactSha256,
  };
}

describe("operational workflow classifier artifact binding", () => {
  it("binds exact wrapper bytes and forwards raw head bytes with separate source pins", async () => {
    const s = setup();
    expect(s.instance.encoderMode).toBe("operational");
    expect(s.artifactSha256).not.toBe(digest(JSON.stringify(artifact)));
    expect(s.createRuntime).toHaveBeenCalledExactlyOnceWith({
      artifactId: artifact.artifactId,
      artifactSha256: artifact.headSha256,
      headArtifact: headJson,
      python: artifact.python,
      workerPath: artifact.workerPath,
      workerSha256: artifact.workerSha256,
      qualificationSha256: artifact.qualificationSha256,
    });
    const result = await s.instance.classify(request());
    expect(result).toMatchObject({
      route: "fast",
      complete: true,
      artifactId: artifact.artifactId,
      artifactSha256: s.artifactSha256,
      headSha256: artifact.headSha256,
      workerSha256: artifact.workerSha256,
      qualificationSha256: artifact.qualificationSha256,
      confidence: 0.98,
      inputTokens: 17,
      featureElapsedMs: 2,
      runtimeOperationalElapsedMs: 4,
      completenessReason: "self-contained-routine",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.operationalElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not substitute canonical bytes when raw artifact text is absent", () => {
    expect(() =>
      setup({ artifactJson: undefined as unknown as string }),
    ).toThrowError(expect.objectContaining({ code: "invalid-artifact-json" }));
  });

  it("rejects a raw SHA calculated after removing the file newline", () => {
    const raw = `${JSON.stringify(artifact, null, 2)}\n`;
    expect(() =>
      setup({ artifactJson: raw, artifactSha256: digest(raw.trimEnd()) }),
    ).toThrowError(expect.objectContaining({ code: "artifact-hash-mismatch" }));
  });

  it("rejects parsed object disagreement with the exact raw wrapper", () => {
    const raw = `${JSON.stringify(artifact)}\n`;
    expect(() =>
      setup({
        artifact: { ...artifact, artifactId: "changed" },
        artifactJson: raw,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "artifact-object-mismatch" }),
    );
  });

  it("rejects duplicate decoded wrapper keys", () => {
    const raw = JSON.stringify(artifact).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    expect(() => setup({ artifactJson: raw })).toThrowError(
      expect.objectContaining({ code: "duplicate-artifact-key" }),
    );
  });

  it("rejects duplicate wrapper keys that use JSON escape spellings", () => {
    const raw = JSON.stringify(artifact).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVer\\u0073ion":1',
    );
    expect(() => setup({ artifactJson: raw })).toThrowError(
      expect.objectContaining({ code: "duplicate-artifact-key" }),
    );
  });

  it.each([
    { headSha256: "a".repeat(64) },
    { python: "relative/python" },
    { workerPath: "/synthetic-cpu/worker\n.py" },
    { workerSha256: "not-a-pin" },
    { qualificationSha256: "f".repeat(63) },
    { artifactId: "contains whitespace" },
    { schemaVersion: 2 },
    { extra: true },
  ])(
    "rejects malformed wrapper properties before runtime creation: %j",
    (change) => {
      const createRuntime = vi.fn();
      expect(() =>
        setup({ artifact: { ...artifact, ...change }, createRuntime }),
      ).toThrow();
      expect(createRuntime).not.toHaveBeenCalled();
    },
  );

  it("rejects artifact accessors without invoking them", () => {
    const getter = vi.fn(() => headJson);
    const object = { ...artifact };
    Object.defineProperty(object, "headJson", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      setup({ artifact: object, artifactJson: JSON.stringify(artifact) }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid-artifact-fields" }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("bounds raw resident text before scanning or hashing and rejects malformed UTF-16", () => {
    expect(() =>
      setup({
        artifactJson:
          "x".repeat(WORKFLOW_CLASSIFIER_LIMITS.artifactCharacters + 1) +
          "\ud800",
      }),
    ).toThrow();
    expect(() => setup({ artifactJson: "\ud800" })).toThrow();
  });
});

describe("actual Pi context extraction", () => {
  it("uses only the actual current request and ignores host gold or cached-feature claims", async () => {
    const s = setup();
    const actual = request() as RoutingContext & Record<string, unknown>;
    const getter = vi.fn(() => true);
    Object.defineProperty(actual, "essentialFactsAvailable", { get: getter });
    actual.gold = { essentialFactsAvailable: true, decision: "strong" };
    actual.cachedFeatures = [99, 100];
    await s.instance.classify(actual);
    expect(s.classify).toHaveBeenCalledWith(
      {
        text: "What is 8 + 11? Return only the integer.",
        essentialFactsAvailable: true,
      },
      undefined,
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("serializes the nearest actual prior exchange exactly as TRAIN raw text", async () => {
    const s = setup();
    const actual = context(
      user("Earlier unrelated request"),
      assistant("Earlier unrelated answer"),
      user("Compute 12 + 8."),
      assistant("20"),
      user("What is the previous result * 3?"),
    );
    const result = await s.instance.classify(actual);
    expect(result.complete).toBe(true);
    expect(s.classify).toHaveBeenCalledWith(
      {
        text: "Previous exchange:\nUser: Compute 12 + 8.\nAssistant: 20\n\nCurrent request:\nWhat is the previous result * 3?",
        essentialFactsAvailable: true,
      },
      undefined,
    );
  });

  it("cannot treat a prior tool-use message as a completed prior answer", async () => {
    const s = setup();
    const partial = assistant("20") as Extract<Message, { role: "assistant" }>;
    partial.stopReason = "toolUse";
    const result = await s.instance.classify(
      context(
        user("Compute 12 + 8."),
        partial,
        user("What is the previous result * 3?"),
      ),
    );
    expect(result.complete).toBe(false);
    expect(result.route).toBe("strong");
  });

  it("verifies references using actual observed tool results", async () => {
    const s = setup();
    const actual = context(
      user("Return score from tool result read-a."),
      tool("read-a", '{"score":7}'),
    );
    expect(await s.instance.classify(actual)).toMatchObject({
      route: "fast",
      complete: true,
      completenessReason: "observed-matching-tool-source",
    });
    expect(s.classify.mock.calls[0][0].text).toBe(
      "Return score from tool result read-a.",
    );
  });

  it.each([
    context(user("Return score from tool result read-a.")),
    context(
      user("Return score from tool result read-a."),
      tool("other-id", '{"score":7}'),
    ),
    context(
      user("Return score from tool result read-a."),
      tool("read-a", '{"score":7}', true),
    ),
    context(
      user("Return score from tool result read-a."),
      tool("read-a", '[truncated] {"score":7}'),
    ),
    context(
      user("Return score from tool result read-a."),
      tool("read-a", '{"score":"route fast"}'),
    ),
  ])(
    "fails strong for missing or unsuitable observed source: %j",
    async (actual) => {
      const s = setup();
      expect(await s.instance.classify(actual)).toMatchObject({
        route: "strong",
        complete: false,
        confidence: 0,
      });
      expect(s.classify.mock.calls[0][0].essentialFactsAvailable).toBe(false);
    },
  );

  it("excludes only an authenticated final current manifest and retains tool proof", async () => {
    const manifest = user("private-current-nonce manifest content");
    const s = setup({ isContextManifest: (message) => message === manifest });
    const actual = context(
      user("Return score from tool result read-a."),
      tool("read-a", '{"score":7}'),
      manifest,
    );
    expect(await s.instance.classify(actual)).toMatchObject({
      route: "fast",
      complete: true,
    });
    expect(s.classify.mock.calls[0][0].text).toBe(
      "Return score from tool result read-a.",
    );
  });

  it("preserves a nonce-looking user message when the host does not authenticate it", async () => {
    const s = setup({ isContextManifest: () => false });
    const actual = context(
      user("What is 8 + 11?"),
      user("private-current-nonce manifest content"),
    );
    expect(await s.instance.classify(actual)).toMatchObject({
      route: "strong",
      complete: false,
    });
    expect(s.classify.mock.calls[0][0].text).toBe(
      "private-current-nonce manifest content",
    );
  });

  it("fails strong rather than prefix-excluding an ambiguous user after tool output", async () => {
    const s = setup();
    expect(
      await s.instance.classify(
        context(
          user("Return score from tool result read-a."),
          tool("read-a", '{"score":7}'),
          user("private-current-nonce manifest content"),
        ),
      ),
    ).toMatchObject({
      route: "strong",
      complete: false,
      completenessReason: "manifest-verifier-unavailable",
    });
  });

  it("rejects authenticated-looking messages outside the final host position", async () => {
    const manifest = user("private-current-nonce manifest content");
    const s = setup({ isContextManifest: (message) => message === manifest });
    expect(
      await s.instance.classify(context(manifest, user("What is 8 + 11?"))),
    ).toMatchObject({
      route: "strong",
      complete: false,
      completenessReason: "invalid-manifest-position",
    });
  });

  it("supports the original trusted custom host manifest and rejects untrusted custom roles", async () => {
    const manifest = {
      role: "custom",
      customType: "invented-host-only",
      content: "private-current-nonce manifest content",
    } as unknown as Message;
    const actual = context(user("What is 8 + 11?"), manifest);
    const trusted = setup({
      isContextManifest: (message) => message === manifest,
    });
    expect(await trusted.instance.classify(actual)).toMatchObject({
      route: "fast",
      complete: true,
    });
    const untrusted = setup();
    expect(await untrusted.instance.classify(actual)).toMatchObject({
      route: "strong",
      complete: false,
    });
  });

  it("fails strong if the trusted host verifier throws", async () => {
    const s = setup({
      isContextManifest: () => {
        throw new Error("invented-host-error");
      },
    });
    expect(await s.instance.classify(request())).toMatchObject({
      route: "strong",
      complete: false,
      completenessReason: "manifest-verification-failed",
    });
  });

  it("does not invoke message text getters", async () => {
    const getter = vi.fn(() => "What is 8 + 11?");
    const message = user("placeholder");
    Object.defineProperty(message, "content", { get: getter });
    const s = setup();
    expect(await s.instance.classify(context(message))).toMatchObject({
      route: "strong",
      complete: false,
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects image and oversized content-block requests as unsupported actual sources", async () => {
    const image = {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "What is 8 + 11?" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
    } as Message;
    const blocks = {
      role: "user",
      timestamp: 1,
      content: Array.from(
        { length: WORKFLOW_CLASSIFIER_LIMITS.contentBlocks + 1 },
        () => ({ type: "text", text: "x" }),
      ),
    } as Message;
    for (const actual of [context(image), context(blocks)]) {
      const s = setup();
      expect(await s.instance.classify(actual)).toMatchObject({
        route: "strong",
        complete: false,
      });
      expect(s.classify.mock.calls[0][0].essentialFactsAvailable).toBe(false);
    }
  });

  it("enforces the worker raw UTF-8 byte budget as well as resident characters", async () => {
    const actual = context(
      user(`Return value: {"value":"${"🦉".repeat(9000)}"}.`),
    );
    const s = setup();
    expect(await s.instance.classify(actual)).toMatchObject({
      route: "strong",
      complete: false,
      completenessReason: "feature-capacity-exceeded",
    });
    expect(s.classify.mock.calls[0][0]).toEqual({
      text: "Unverified context.",
      essentialFactsAvailable: false,
    });
  });

  it("rejects duplicate observed tool IDs and aggregate source excess", async () => {
    for (const actual of [
      context(
        user("What is 8 + 11?"),
        tool("read-a", "7"),
        tool("read-a", "8"),
      ),
      context(
        user("What is 8 + 11?"),
        ...Array.from({ length: 5 }, (_, i) =>
          tool(`read-${i}`, "x".repeat(65535)),
        ),
      ),
    ]) {
      const s = setup();
      expect(await s.instance.classify(actual)).toMatchObject({
        route: "strong",
        complete: false,
      });
    }
  });

  it.each([
    context(user("What is 8 + 11?\ud800")),
    context(user("x".repeat(65537))),
    context(
      ...Array.from(
        { length: WORKFLOW_CLASSIFIER_LIMITS.contextMessages + 1 },
        () => user("What is 8 + 11?"),
      ),
    ),
    context(
      user("What is 8 + 11?"),
      ...Array.from({ length: 33 }, (_, i) => tool(`read-${i}`, "7")),
    ),
  ])(
    "bounds or rejects invalid actual sources without inference case %#",
    async (actual) => {
      const s = setup();
      expect(await s.instance.classify(actual)).toMatchObject({
        route: "strong",
        complete: false,
      });
      expect(s.classify.mock.calls[0][0].essentialFactsAvailable).toBe(false);
    },
  );
});

describe("eligibility, cancellation, and lifecycle", () => {
  it("uses actual completeness and matching qualified wrapper/source identities", async () => {
    const s = setup();
    const classification = await s.instance.classify(request());
    expect(
      s.instance.eligibility(request(), {
        classification: { ...classification },
        qualification: s.qualification,
        mode: "auto",
      }),
    ).toEqual({ eligibleForFast: true, reason: "qualified-classifier-fast" });
    expect(
      s.instance.eligibility(context(user("Read the missing required file.")), {
        classification,
        qualification: s.qualification,
        mode: "auto",
      }),
    ).toEqual({
      eligibleForFast: false,
      reason: "completeness-unverified",
      completenessReason: "explicit-missing-facts",
    });
  });

  it.each([
    ["Read the missing required file.", "explicit-missing-facts"],
    [
      'Compute 6 + 13. Return {"result":19} as JSON.',
      "unsupported-or-unverified-routine",
    ],
  ])(
    "reports actual proof rejection distinctly and rejects forged fast claims: %s",
    async (prompt, reason) => {
      const s = setup();
      const priorClassification = await s.instance.classify(request());
      const actual = context(user(prompt)) as RoutingContext &
        Record<string, unknown>;
      actual.essentialFactsAvailable = true;
      actual.gold = { complete: true, label: "easy", expected: { result: 19 } };
      const classification = {
        ...priorClassification,
        route: "fast" as const,
        complete: true,
        confidence: 1,
        sourceSha256: digest(JSON.stringify({ prompt, toolResults: [] })),
      };
      expect(
        s.instance.eligibility(actual, {
          classification,
          qualification: s.qualification,
          mode: "auto",
        }),
      ).toEqual({
        eligibleForFast: false,
        reason: "completeness-unverified",
        completenessReason: reason,
      });
      expect(s.classify).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a classification reused with a different verified source request", async () => {
    const s = setup();
    const classification = await s.instance.classify(request());
    expect(
      s.instance.eligibility(context(user("Compute 3 + 4.")), {
        classification,
        qualification: s.qualification,
        mode: "auto",
      }),
    ).toEqual({ eligibleForFast: false, reason: "context-binding-mismatch" });
  });

  it.each(["off", "strong"] as const)(
    "never qualifies a fast route in %s mode",
    async (mode) => {
      const s = setup();
      const classification = await s.instance.classify(request());
      expect(
        s.instance.eligibility(request(), {
          classification,
          qualification: s.qualification,
          mode,
        }),
      ).toEqual({ eligibleForFast: false, reason: "mode-ineligible" });
    },
  );

  it.each([
    "artifactId",
    "artifactSha256",
    "headSha256",
    "workerSha256",
    "qualificationSha256",
  ])("rejects altered classification pin %s", async (key) => {
    const s = setup();
    const classification = {
      ...(await s.instance.classify(request())),
      [key]: "wrong",
    };
    expect(
      s.instance.eligibility(request(), {
        classification,
        qualification: s.qualification,
        mode: "auto",
      }).eligibleForFast,
    ).toBe(false);
  });

  it.each([
    { qualified: false },
    { artifactId: "another-artifact" },
    { artifactSha256: "b".repeat(64) },
    { qualificationSha256: "c".repeat(64) },
  ])(
    "rejects an unqualified or mismatched qualification %j",
    async (change) => {
      const s = setup();
      const classification = await s.instance.classify(request());
      expect(
        s.instance.eligibility(request(), {
          classification,
          qualification: { ...s.qualification, ...change },
          mode: "auto",
        }),
      ).toEqual({ eligibleForFast: false, reason: "unqualified-artifact" });
    },
  );

  it("keeps confidence and high-risk request exclusions in the actual guard", async () => {
    const s = setup();
    const classification = await s.instance.classify(request());
    expect(
      s.instance.eligibility(request(), {
        classification: { ...classification, confidence: 0.2 },
        qualification: s.qualification,
        mode: "auto",
      }).reason,
    ).toBe("classifier-confidence-below-threshold");
    const securityRequest = context(
      user('Return the security field: {"security":true}.'),
    );
    const securityClassification = await s.instance.classify(securityRequest);
    expect(securityClassification.complete).toBe(true);
    expect(
      s.instance.eligibility(securityRequest, {
        classification: securityClassification,
        qualification: s.qualification,
        mode: "auto",
      }).reason,
    ).toBe("security-sensitive");
  });

  it("never routes an unverified request fast even if an injected runtime violates fallback", async () => {
    const s = setup();
    const valid = await s.instance.classify(request());
    s.classify.mockResolvedValueOnce({
      decision: "fast",
      confidence: 1,
      calibration: "uncalibrated",
      reason: "head-score",
      artifactId: artifact.artifactId,
      artifactSha256: artifact.headSha256,
      qualificationSha256: artifact.qualificationSha256,
      workerSha256: artifact.workerSha256,
      fastScore: 1,
      strongScore: 0,
      inputTokens: 0,
      featureElapsedMs: 0,
      operationalElapsedMs: 0,
      provenance: valid.provenance,
    });
    expect(
      await s.instance.classify(context(user("Use the unattached document."))),
    ).toMatchObject({ route: "strong", complete: false, confidence: 0 });
  });

  it("rejects runtime output bound to a different head", async () => {
    const s = setup();
    const value = await s.classify({
      text: "invented",
      essentialFactsAvailable: true,
    });
    s.classify.mockResolvedValueOnce({
      ...value,
      artifactSha256: "a".repeat(64),
    });
    await expect(s.instance.classify(request())).rejects.toMatchObject({
      code: "runtime-binding-mismatch",
    });
  });

  it("propagates the caller cancellation signal and runtime errors", async () => {
    const s = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(
      s.instance.classify(request(), { signal: abort.signal }),
    ).rejects.toThrow("invented-cpu-aborted");
    expect(s.classify.mock.calls[0][1]).toBe(abort.signal);
    s.classify.mockRejectedValueOnce(new Error("invented-runtime-failure"));
    await expect(s.instance.classify(request())).rejects.toThrow(
      "invented-runtime-failure",
    );
  });

  it("rejects a late result after cancellation even when an injected runtime ignores abort", async () => {
    const s = setup();
    const result = await s.classify({
      text: "invented",
      essentialFactsAvailable: true,
    });
    let release!: (value: RoutingRuntimeResult) => void;
    s.classify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const abort = new AbortController();
    const pending = s.instance.classify(request(), { signal: abort.signal });
    abort.abort();
    release(result);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects a late result after disposal even when an injected runtime ignores ownership", async () => {
    const s = setup();
    const result = await s.classify({
      text: "invented",
      essentialFactsAvailable: true,
    });
    let release!: (value: RoutingRuntimeResult) => void;
    s.classify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = s.instance.classify(request());
    await s.instance.dispose();
    release(result);
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
  });

  it("awaits disposal once, rejects new classification, and preserves cleanup uncertainty", async () => {
    const s = setup();
    let release!: () => void;
    s.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = s.instance.dispose();
    expect(s.instance.dispose()).toBe(first);
    await Promise.resolve();
    expect(s.dispose).toHaveBeenCalledTimes(1);
    await expect(s.instance.classify(request())).rejects.toMatchObject({
      code: "disposed",
    });
    release();
    await first;
    const failed = setup();
    failed.dispose.mockRejectedValueOnce(
      new Error("invented-cleanup-uncertain"),
    );
    await expect(failed.instance.dispose()).rejects.toThrow(
      "invented-cleanup-uncertain",
    );
  });
});
