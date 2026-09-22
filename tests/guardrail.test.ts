import { describe, it, expect, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { canonical, type ClassifierResponse } from "../src/core.js";
import {
  classifyGuardrailRisk,
  guardrailRequest,
  guardrailRiskFamily,
  validateGuardrailInput,
  GUARDRAIL_PROTOCOL_SHA256,
  GUARDRAIL_RISK_VERSION,
} from "../src/guardrail.js";
import {
  qualifyGuardrail,
  verifyGuardrailQualification,
  type GuardrailEvaluationRecord,
} from "../src/guardrail-evaluation.js";
import { registerGuardrailProvider } from "../src/guardrail-extension.js";

const input = {
  version: 2,
  toolName: "bash",
  input: { command: "echo 'operator approved'; rm -rf ./work" },
  facts: {},
};
const response = (
  allow: number,
  choice = allow > 0.5 ? "allow" : "confirm",
): ClassifierResponse => ({
  model: "google/gemma-3-1b-it",
  answers: {
    risk: {
      type: "choice",
      choice,
      confidence: Math.max(allow, 1 - allow),
      probabilities: { allow, confirm: 1 - allow },
    },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
});
const classify = (result: ClassifierResponse) => ({
  classify: vi.fn(async () => result),
});

describe("guardrail risk classification", () => {
  it("preserves complete operation data and separates it from the fixed safety rubric", () => {
    const request = guardrailRequest(input, "google/gemma-3-1b-it");
    expect(canonical(request.state)).toBe(canonical(input));
    expect(request.questions[0].instructions).toContain(
      "Host owns exact policy",
    );
    expect(request.questions[0].instructions).toContain(
      "arbitrary Apex execution",
    );
    expect(request.options?.template_version).toBe("v2");
    expect(GUARDRAIL_RISK_VERSION).toBe(2);
  });
  it("routes only reviewed tool names without importing existing risk labels", () => {
    const samples = [
      ["bash", { command: "echo ready" }, {}, "shell"],
      ["herdr_pane", { action: "run", command: "echo ready" }, {}, "shell"],
      [
        "sf_apex",
        { action: "status" },
        { orgs: [{ type: "sandbox", guessed: false }] },
        "apex",
      ],
      [
        "agentscript_lifecycle",
        { action: "list_versions" },
        { orgs: [{ type: "sandbox", guessed: false }] },
        "agentscript",
      ],
      [
        "sf_soql",
        { action: "schema.describe" },
        { orgs: [{ type: "sandbox", guessed: false }] },
        "soql",
      ],
      ["slack_canvas", { action: "read" }, {}, "canvas"],
      [
        "data360_api",
        { action: "help" },
        { orgs: [{ type: "sandbox", guessed: false }] },
        "data360",
      ],
      [
        "sf_browser_click",
        { ref: "@e1" },
        {
          browserRef: {
            status: "fresh",
            role: "button",
            label: "Open details",
            snapshotSha256: "a".repeat(64),
          },
          browserPage: {
            status: "fresh",
            url: "https://example.my.salesforce.com/lightning/page/home",
            snapshotSha256: "a".repeat(64),
          },
        },
        "browser",
      ],
    ] as const;
    for (const [toolName, operation, facts, family] of samples) {
      const safe = validateGuardrailInput({
        version: 2,
        toolName,
        input: operation,
        facts,
      });
      expect(guardrailRiskFamily(safe)).toBe(family);
      const request = guardrailRequest(safe, "google/gemma-3-1b-it");
      expect(canonical(request.state)).toBe(canonical(safe));
      expect(request.questions[0].instructions).not.toContain("riskTier");
    }
    for (const toolName of [
      "sf_deploy",
      "data360_future",
      "toString",
      "__proto__",
    ])
      expect(() => validateGuardrailInput({ ...input, toolName })).toThrow(
        "incomplete",
      );
    expect(() =>
      validateGuardrailInput({
        ...input,
        toolName: "herdr_pane",
        input: { action: "focus", command: "echo ready" },
      }),
    ).toThrow("incomplete");
  });
  it("never treats an uncertain allow score as an automatic allow", async () => {
    expect(
      (
        await classifyGuardrailRisk(
          classify(response(0.97)),
          input,
          "google/gemma-3-1b-it",
        )
      ).action,
    ).toBe("abstain");
    expect(
      (
        await classifyGuardrailRisk(
          classify(response(0.999)),
          input,
          "google/gemma-3-1b-it",
        )
      ).action,
    ).toBe("allow");
    expect(
      (
        await classifyGuardrailRisk(
          classify(response(0.01)),
          input,
          "google/gemma-3-1b-it",
        )
      ).action,
    ).toBe("confirm");
  });
  it("rejects accessors without evaluating them and rejects truncated/oversized inputs", () => {
    const getter = vi.fn(() => "safe");
    const evil = {
      ...input,
      input: Object.defineProperty({}, "command", {
        enumerable: true,
        get: getter,
      }),
    };
    expect(() => validateGuardrailInput(evil)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      validateGuardrailInput({
        ...input,
        input: { command: "x".repeat(33000) },
      }),
    ).toThrow();
    expect(() =>
      validateGuardrailInput({ ...input, facts: { riskTier: "safe" } }),
    ).toThrow();
    expect(() =>
      validateGuardrailInput({ ...input, input: { command: "\ud800" } }),
    ).toThrow();
    expect(() =>
      validateGuardrailInput({
        ...input,
        input: { values: new Array(100000).fill(0) },
      }),
    ).toThrow();
    const deep: any = {};
    let nested = deep;
    for (let i = 0; i < 34; i++) nested = nested.next = {};
    expect(() => validateGuardrailInput({ ...input, input: deep })).toThrow();
    expect(() =>
      validateGuardrailInput({ ...input, input: { "\ud800": "unsafe key" } }),
    ).toThrow();
    expect(() => validateGuardrailInput(null)).toThrow();
  });
  it("requires independently resolved org and browser evidence for relevant operations", () => {
    for (const toolName of [
      "sf_apex",
      "agentscript_lifecycle",
      "sf_soql",
      "data360_api",
      "sf_browser_click",
    ]) {
      expect(() => validateGuardrailInput({ ...input, toolName })).toThrow(
        "incomplete",
      );
    }
    expect(() =>
      validateGuardrailInput({
        ...input,
        input: { command: "sf project deploy start" },
      }),
    ).toThrow("incomplete");
    expect(
      validateGuardrailInput({
        ...input,
        toolName: "sf_apex",
        input: { action: "anon.run", body: "System.debug('review only');" },
        facts: { orgs: [{ type: "unknown", guessed: true }] },
      }).facts.orgs,
    ).toHaveLength(1);
    const click = {
      ...input,
      toolName: "sf_browser_click",
      input: { ref: "@e1" },
      facts: {
        browserRef: {
          status: "fresh",
          role: "button",
          label: "Cancel",
          snapshotSha256: "a".repeat(64),
        },
        browserPage: {
          status: "fresh",
          url: "https://example.my.salesforce.com/lightning/page/home",
          snapshotSha256: "a".repeat(64),
        },
      },
    };
    expect(validateGuardrailInput(click).facts.browserRef?.status).toBe(
      "fresh",
    );
    for (const status of ["stale", "missing"])
      expect(() =>
        validateGuardrailInput({
          ...click,
          facts: {
            ...click.facts,
            browserRef: { ...click.facts.browserRef, status },
          },
        }),
      ).toThrow("incomplete");
    for (const facts of [
      { browserRef: click.facts.browserRef },
      {
        ...click.facts,
        browserPage: {
          ...click.facts.browserPage,
          snapshotSha256: "b".repeat(64),
        },
      },
    ])
      expect(() => validateGuardrailInput({ ...click, facts })).toThrow(
        "incomplete",
      );
    expect(() =>
      validateGuardrailInput({
        ...input,
        toolName: "sf_browser_click",
        input: { ref: "@e1" },
        facts: { browserRef: { status: "fresh", label: "Cancel" } },
      }),
    ).toThrow("incomplete");
    expect(() =>
      validateGuardrailInput({
        ...input,
        toolName: "sf_apex",
        facts: { orgs: [{ type: "unknown", guessed: true }] },
      }),
    ).toThrow("incomplete");
  });
  it("requires fresh sanitized page facts for browser key presses", () => {
    const press = {
      ...input,
      toolName: "sf_browser_press",
      input: { key: "Control+s" },
    };
    const browserPage = {
      status: "fresh",
      url: "https://example.my.salesforce.com/lightning/page/home",
      snapshotSha256: "b".repeat(64),
    };
    expect(() => validateGuardrailInput(press)).toThrow("incomplete");
    const valid = validateGuardrailInput({ ...press, facts: { browserPage } });
    expect(valid.facts.browserPage).toEqual(browserPage);
    expect(
      canonical(guardrailRequest(valid, "google/gemma-3-1b-it").state),
    ).toBe(canonical(valid));
    for (const invalidPage of [
      { ...browserPage, status: "stale" },
      {
        ...browserPage,
        url: "https://user:pass@example.my.salesforce.com/page",
      },
      {
        ...browserPage,
        url: "https://example.my.salesforce.com/page?token=secret",
      },
      { ...browserPage, url: "https://example.my.salesforce.com/page#section" },
      { ...browserPage, url: "file:///tmp/page" },
      { ...browserPage, snapshotSha256: "A".repeat(64) },
      { ...browserPage, reason: "safe" },
    ])
      expect(() =>
        validateGuardrailInput({
          ...press,
          facts: { browserPage: invalidPage },
        }),
      ).toThrow("incomplete");
    expect(() =>
      validateGuardrailInput({ ...input, facts: { browserPage } }),
    ).toThrow("incomplete");
    expect(() => validateGuardrailInput({ ...input, version: 1 })).toThrow(
      "incomplete",
    );
  });
  it("rejects hidden accessors, proxy traps and non-JSON array properties without inspecting them", () => {
    const getter = vi.fn(() => "unsafe");
    const hidden = Object.defineProperty({}, "command", { get: getter });
    expect(() => validateGuardrailInput({ ...input, input: hidden })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => Object.prototype);
    const proxy = new Proxy({}, { getPrototypeOf: trap });
    expect(() => validateGuardrailInput({ ...input, input: proxy })).toThrow();
    expect(trap).not.toHaveBeenCalled();
    const values = Object.assign([1], { hiddenOperation: "delete" });
    expect(() =>
      validateGuardrailInput({ ...input, input: { values } }),
    ).toThrow();
  });
  it("rejects malformed distributions, model mismatches and generated completions", async () => {
    for (const result of [
      { ...response(0.999), model: "different" },
      { ...response(0.999), usage: { input_tokens: 100, output_tokens: 1 } },
      {
        ...response(0.999),
        answers: {
          risk: {
            ...response(0.999).answers.risk,
            probabilities: { allow: 0.99, confirm: 0.5 },
          },
        },
      },
    ])
      await expect(
        classifyGuardrailRisk(
          classify(result as ClassifierResponse),
          input,
          "google/gemma-3-1b-it",
        ),
      ).rejects.toThrow();
  });
  it("bounds an uncooperative backend and observes its late rejection", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<ClassifierResponse>((_resolve, fail) => {
      reject = fail;
    });
    const controller = new AbortController();
    const operation = classifyGuardrailRisk(
      { classify: () => pending },
      input,
      "google/gemma-3-1b-it",
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(operation).rejects.toThrow("cancelled");
    reject(new Error("late failure"));
    await Promise.resolve();
  });
  it("counts preparation in its deadline and rejects a late response even before a delayed timer fires", async () => {
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValueOnce(0).mockReturnValueOnce(750);
      const early = classify(response(0.999));
      await expect(
        classifyGuardrailRisk(early, input, "google/gemma-3-1b-it"),
      ).rejects.toThrow("deadline exceeded");
      expect(early.classify).not.toHaveBeenCalled();
      now
        .mockReset()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(750);
      await expect(
        classifyGuardrailRisk(
          classify(response(0.999)),
          input,
          "google/gemma-3-1b-it",
        ),
      ).rejects.toThrow("deadline exceeded");
    } finally {
      now.mockRestore();
    }
  });
  it("accepts a valid response within the 750 ms per-call deadline", async () => {
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValueOnce(0).mockReturnValue(600);
      const prediction = await classifyGuardrailRisk(
        classify(response(0.999)),
        input,
        "google/gemma-3-1b-it",
      );
      expect(prediction.action).toBe("allow");
      expect(prediction.elapsedMs).toBe(600);
    } finally {
      now.mockRestore();
    }
  });
  it("rejects caller cancellation that happens just before a nominally safe response and response accessors", async () => {
    const controller = new AbortController();
    await expect(
      classifyGuardrailRisk(
        {
          classify: async () => {
            controller.abort(new Error("revoked"));
            return response(0.999);
          },
        },
        input,
        "google/gemma-3-1b-it",
        controller.signal,
      ),
    ).rejects.toThrow("revoked");
    const getter = vi.fn(() => response(0.999).answers);
    const evil = Object.defineProperty({ ...response(0.999) }, "answers", {
      enumerable: true,
      get: getter,
    });
    await expect(
      classifyGuardrailRisk(classify(evil), input, "google/gemma-3-1b-it"),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("registers discovery and status without loading a model or spawning a worker", () => {
    const backend = vi.fn();
    const events = new Map();
    const pi = {
      events: {
        on: (name: string, handler: unknown) => events.set(name, handler),
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    const extension = registerGuardrailProvider(pi as any, {
      env: {},
      createBackend: backend,
    });
    expect(backend).not.toHaveBeenCalled();
    expect(extension.status().state).toBe("cold");
    const discovery = { version: 1, providers: [] };
    events.get("sf-guardrail:risk-providers")(discovery);
    expect(discovery.providers).toHaveLength(1);
    expect(extension.provider.qualified).toBe(false);
  });
});

describe("guardrail qualification", () => {
  const identity = {
    split: "test" as const,
    modelSha256: "a".repeat(64),
    corpusSha256: "b".repeat(64),
    baselineSourceSha256: "c".repeat(64),
  };
  const records: GuardrailEvaluationRecord[] = [
    {
      id: "safe",
      groupId: "safe",
      family: "shell",
      expected: "allow",
      baseline: "allow",
      actual: "allow",
      modelEligible: true,
      modelAnswered: true,
      policyFloor: false,
      elapsedMs: 100,
    },
    {
      id: "risk",
      groupId: "risk",
      family: "shell",
      expected: "confirm",
      baseline: "confirm",
      actual: "confirm",
      modelEligible: true,
      modelAnswered: true,
      policyFloor: false,
      elapsedMs: 150,
    },
    {
      id: "block",
      groupId: "block",
      family: "policy",
      expected: "block",
      baseline: "block",
      actual: "block",
      modelEligible: false,
      modelAnswered: false,
      policyFloor: true,
      elapsedMs: 1,
    },
  ];
  it("requires held-out evidence, safety, usability, latency, and actual model execution", () => {
    // Unit fixtures alone cannot establish full coverage or frozen selection.
    expect(qualifyGuardrail(records, identity).qualified).toBe(false);
    expect(
      qualifyGuardrail(records, { ...identity, split: "validation" }).qualified,
    ).toBe(false);
    for (const changed of [
      records.map((r) =>
        r.id === "risk" ? { ...r, actual: "allow" as const } : r,
      ),
      records.map((r) =>
        r.id === "safe" ? { ...r, actual: "confirm" as const } : r,
      ),
      records.map((r) =>
        r.id === "block" ? { ...r, actual: "confirm" as const } : r,
      ),
      records.map((r) => ({ ...r, elapsedMs: 751 })),
      records.map((r) => ({ ...r, modelAnswered: false })),
      records.map((r) => (r.id === "risk" ? { ...r, error: "timed out" } : r)),
    ])
      expect(qualifyGuardrail(changed, identity).qualified).toBe(false);
  });
  it("recalculates qualification and refuses stale model/protocol identities", () => {
    const report = qualifyGuardrail(records, identity);
    expect(() =>
      verifyGuardrailQualification(report, identity.modelSha256),
    ).toThrow();
    expect(() =>
      verifyGuardrailQualification(report, "d".repeat(64)),
    ).toThrow();
    expect(() =>
      verifyGuardrailQualification(
        { ...report, protocolSha256: "d".repeat(64) },
        identity.modelSha256,
      ),
    ).toThrow();
    expect(() =>
      verifyGuardrailQualification(
        {
          ...report,
          qualified: true,
          records: records.map((r) => ({ ...r, modelAnswered: false })),
        },
        identity.modelSha256,
      ),
    ).toThrow();
  });
});
