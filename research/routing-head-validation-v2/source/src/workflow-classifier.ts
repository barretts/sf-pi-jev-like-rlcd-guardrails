import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import {
  ROUTING_COMPLETENESS_LIMITS,
  verifyRoutingCompleteness,
  type RoutingCompleteness,
  type RoutingCompletenessInput,
} from "./routing-completeness.js";
import {
  evaluateRoutingEligibility,
  type RoutingPreviousExchange,
} from "./routing-guards.js";
import {
  createRoutingRuntime,
  ROUTING_RUNTIME_LIMITS,
  type RoutingRuntimeOptions,
  type RoutingRuntimeResult,
} from "./routing-runtime.js";
import type {
  RoutingClassification,
  RoutingContext,
  RoutingEligibility,
  RoutingMode,
  RoutingQualification,
} from "./routing-extension.js";

export interface WorkflowClassifierArtifact {
  schemaVersion: 1;
  artifactId: string;
  headJson: string;
  headSha256: string;
  python: string;
  workerPath: string;
  workerSha256: string;
  qualificationSha256: string;
}

type Runtime = Pick<
  ReturnType<typeof createRoutingRuntime>,
  "classify" | "dispose"
>;
export interface WorkflowClassifierOptions {
  artifact: unknown;
  artifactSha256: string;
  /** Exact UTF-8 artifact file text, including whitespace and final newline. */
  artifactJson: string;
  /** Trusted host callback; never a marker parser supplied by task data. */
  isContextManifest?: (message: unknown) => boolean;
  /** CPU-test dependency injection. The production default is the operational driver. */
  createRuntime?: (options: RoutingRuntimeOptions) => Runtime;
}

export interface WorkflowClassification extends RoutingClassification {
  sourceSha256: string;
  headSha256: string;
  workerSha256: string;
  qualificationSha256: string;
  completenessReason: string;
  calibration: "uncalibrated";
  inputTokens: number;
  featureElapsedMs: number;
  runtimeOperationalElapsedMs: number;
  /** Includes context extraction and completeness verification as well as the driver. */
  operationalElapsedMs: number;
  provenance: RoutingRuntimeResult["provenance"];
}

export interface WorkflowEligibility extends RoutingEligibility {
  completenessReason?: string;
}

export const WORKFLOW_CLASSIFIER_LIMITS = Object.freeze({
  artifactCharacters: 2 * 1024 * 1024,
  artifactBytes: 2 * 1024 * 1024,
  contextMessages: 256,
  contentBlocks: 128,
  sourceCharacters: ROUTING_COMPLETENESS_LIMITS.aggregateCharacters,
});

export class WorkflowClassifierError extends Error {
  constructor(readonly code: string) {
    super(`Workflow classifier: ${code}`);
    this.name = "WorkflowClassifierError";
  }
}
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const fields = [
  "schemaVersion",
  "artifactId",
  "headJson",
  "headSha256",
  "python",
  "workerPath",
  "workerSha256",
  "qualificationSha256",
] as const;
function fail(code: string): never {
  throw new WorkflowClassifierError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
/** Do not execute getters in messages or caller-supplied artifact objects. */
function data(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validPin(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    !/[\0\r\n]/.test(value) &&
    wellFormed(value)
  );
}
function wrapper(
  options: WorkflowClassifierOptions,
): WorkflowClassifierArtifact {
  const raw = options.artifactJson;
  if (
    typeof raw !== "string" ||
    raw.length > WORKFLOW_CLASSIFIER_LIMITS.artifactCharacters ||
    !wellFormed(raw) ||
    Buffer.byteLength(raw, "utf8") > WORKFLOW_CLASSIFIER_LIMITS.artifactBytes
  )
    fail("invalid-artifact-json");
  if (!validPin(options.artifactSha256)) fail("invalid-artifact-pin");
  if (sha256(raw) !== options.artifactSha256) fail("artifact-hash-mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid-artifact-json");
  }
  if (!record(parsed) || !record(options.artifact)) fail("invalid-artifact");
  for (const object of [parsed, options.artifact]) {
    if (
      Reflect.ownKeys(object).length !== fields.length ||
      !fields.every((key) =>
        Object.hasOwn(Object.getOwnPropertyDescriptors(object), key),
      ) ||
      !fields.every((key) =>
        Object.hasOwn(Object.getOwnPropertyDescriptor(object, key)!, "value"),
      )
    )
      fail("invalid-artifact-fields");
  }
  // The wrapper is flat. Skip entire JSON string tokens, including the escaped
  // head JSON, and reject duplicate decoded outer keys before accepting it.
  const keys = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '"') continue;
    const start = i++;
    while (raw[i] !== '"') {
      if (raw[i] === "\\") i++;
      i++;
    }
    let next = i + 1;
    while (next < raw.length && /\s/.test(raw[next])) next++;
    if (raw[next] === ":") {
      const key = JSON.parse(raw.slice(start, i + 1)) as string;
      if (keys.has(key)) fail("duplicate-artifact-key");
      keys.add(key);
    }
  }
  if (!fields.every((key) => data(parsed, key) === data(options.artifact, key)))
    fail("artifact-object-mismatch");
  const copy = Object.fromEntries(
    fields.map((key) => [key, data(parsed, key)]),
  );
  if (
    copy.schemaVersion !== 1 ||
    typeof copy.artifactId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(copy.artifactId) ||
    typeof copy.headJson !== "string" ||
    copy.headJson.length > 512 * 1024 ||
    !wellFormed(copy.headJson) ||
    Buffer.byteLength(copy.headJson, "utf8") > 512 * 1024 ||
    !validPin(copy.headSha256) ||
    !validPin(copy.workerSha256) ||
    !validPin(copy.qualificationSha256) ||
    !validPath(copy.python) ||
    !validPath(copy.workerPath)
  )
    fail("invalid-artifact");
  if (sha256(copy.headJson) !== copy.headSha256) fail("head-hash-mismatch");
  return Object.freeze(copy) as unknown as WorkflowClassifierArtifact;
}

interface Extracted {
  input: RoutingCompletenessInput;
  featureText: string;
  completeness: RoutingCompleteness;
}
function unknown(reason: string): Extracted {
  return {
    input: { prompt: "Unverified context." },
    featureText: "Unverified context.",
    completeness: { verified: false, reason },
  };
}
interface TextMessage {
  role: "user" | "assistant" | "toolResult";
  text: string;
  toolCallId?: string;
  isError?: boolean;
  terminalAssistant: boolean;
}

function extract(
  context: unknown,
  isContextManifest: WorkflowClassifierOptions["isContextManifest"],
): Extracted {
  if (!record(context)) return unknown("invalid-context");
  const messages = data(context, "messages");
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > WORKFLOW_CLASSIFIER_LIMITS.contextMessages
  )
    return unknown("context-capacity-or-shape");
  const parsed: TextMessage[] = [];
  let aggregate = 0;
  let manifestCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = data(messages, String(i));
    if (!record(message)) return unknown("invalid-message");
    const role = data(message, "role");
    let trusted = false;
    if (isContextManifest) {
      try {
        trusted = isContextManifest(message) === true;
      } catch {
        return unknown("manifest-verification-failed");
      }
    }
    if (trusted) {
      if (
        !["user", "custom"].includes(role as string) ||
        i !== messages.length - 1 ||
        ++manifestCount !== 1
      )
        return unknown("invalid-manifest-position");
      continue;
    }
    if (!["user", "assistant", "toolResult"].includes(role as string))
      return unknown("unverified-message-role");
    const content = data(message, "content");
    const chunks: string[] = [];
    let hasToolCall = false;
    if (typeof content === "string") chunks.push(content);
    else if (
      Array.isArray(content) &&
      content.length <= WORKFLOW_CLASSIFIER_LIMITS.contentBlocks
    ) {
      for (let j = 0; j < content.length; j++) {
        const part = data(content, String(j));
        if (!record(part)) return unknown("invalid-content-block");
        const type = data(part, "type");
        if (type === "text") {
          const text = data(part, "text");
          if (typeof text !== "string") return unknown("invalid-message-text");
          chunks.push(text);
        } else if (role === "assistant" && type === "toolCall")
          hasToolCall = true;
        else if (!(role === "assistant" && type === "thinking"))
          return unknown("unsupported-message-content");
      }
    } else return unknown("invalid-message-content");
    // Bound each source before joining it or any verifier normalization.
    let length = 0;
    for (const chunk of chunks) {
      length += chunk.length;
      if (length > ROUTING_COMPLETENESS_LIMITS.toolTextCharacters)
        return unknown("source-capacity-exceeded");
    }
    length += Math.max(0, chunks.length - 1);
    aggregate += length;
    if (
      length > ROUTING_COMPLETENESS_LIMITS.toolTextCharacters ||
      aggregate > WORKFLOW_CLASSIFIER_LIMITS.sourceCharacters
    )
      return unknown("source-capacity-exceeded");
    const text = chunks.join("\n");
    if (!wellFormed(text)) return unknown("invalid-source-encoding");
    const stopReason = data(message, "stopReason");
    if (
      role === "assistant" &&
      stopReason !== undefined &&
      !["stop", "toolUse"].includes(stopReason as string)
    )
      return unknown("incomplete-assistant-source");
    const item: TextMessage = {
      role: role as TextMessage["role"],
      text,
      terminalAssistant:
        role === "assistant" && !hasToolCall && stopReason === "stop",
    };
    if (role === "toolResult") {
      const id = data(message, "toolCallId");
      const error = data(message, "isError");
      if (
        typeof id !== "string" ||
        id.length > ROUTING_COMPLETENESS_LIMITS.toolIdCharacters ||
        (error !== undefined && typeof error !== "boolean")
      )
        return unknown("invalid-tool-result");
      aggregate += id.length;
      if (aggregate > WORKFLOW_CLASSIFIER_LIMITS.sourceCharacters)
        return unknown("source-capacity-exceeded");
      item.toolCallId = id;
      item.isError = error as boolean | undefined;
    }
    parsed.push(item);
  }
  const latest = parsed.findLastIndex((message) => message.role === "user");
  if (latest < 0 || !parsed[latest].text.trim())
    return unknown("missing-user-request");
  // A converted host manifest follows tool output. Without an authenticated
  // host callback, preserve that user message and reject the ambiguous request.
  if (
    !isContextManifest &&
    parsed.slice(0, latest).some((m) => m.role === "toolResult")
  )
    return unknown("manifest-verifier-unavailable");
  const prompt = parsed[latest].text;
  let previousExchange: RoutingPreviousExchange | undefined;
  const prior = parsed.findLastIndex(
    (message, index) => index < latest && message.role === "user",
  );
  if (prior >= 0) {
    const answer = parsed
      .slice(prior + 1, latest)
      .findLast((message) => message.terminalAssistant && message.text.trim());
    if (answer)
      previousExchange = { user: parsed[prior].text, assistant: answer.text };
  }
  const toolResults = parsed
    .filter((message) => message.role === "toolResult")
    .map((message) => ({
      toolCallId: message.toolCallId!,
      text: message.text,
      ...(message.isError === undefined ? {} : { isError: message.isError }),
    }));
  const input: RoutingCompletenessInput = {
    prompt,
    ...(previousExchange ? { previousExchange } : {}),
    toolResults,
  };
  const completeness = verifyRoutingCompleteness(input);
  const featureText = previousExchange
    ? `Previous exchange:\nUser: ${previousExchange.user}\nAssistant: ${previousExchange.assistant}\n\nCurrent request:\n${prompt}`
    : prompt;
  if (
    featureText.length > ROUTING_RUNTIME_LIMITS.textBytes ||
    Buffer.byteLength(featureText, "utf8") > ROUTING_RUNTIME_LIMITS.textBytes
  )
    return unknown("feature-capacity-exceeded");
  return { input, featureText, completeness };
}

export function createWorkflowClassifier(options: WorkflowClassifierOptions) {
  const artifact = wrapper(options);
  if (
    options.isContextManifest !== undefined &&
    typeof options.isContextManifest !== "function"
  )
    fail("invalid-manifest-verifier");
  const artifactSha256 = options.artifactSha256;
  const isContextManifest = options.isContextManifest;
  const runtime = (options.createRuntime ?? createRoutingRuntime)({
    headArtifact: artifact.headJson,
    artifactSha256: artifact.headSha256,
    artifactId: artifact.artifactId,
    qualificationSha256: artifact.qualificationSha256,
    python: artifact.python,
    workerPath: artifact.workerPath,
    workerSha256: artifact.workerSha256,
  });
  let disposed = false;
  let disposal: Promise<void> | undefined;
  return {
    encoderMode: "operational" as const,
    async classify(
      context: RoutingContext,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<WorkflowClassification> {
      if (disposed) fail("disposed");
      const started = performance.now();
      const actual = extract(context, isContextManifest);
      const result = await runtime.classify(
        {
          text: actual.featureText,
          essentialFactsAvailable: actual.completeness.verified,
        },
        signal,
      );
      if (disposed) fail("disposed");
      if (signal?.aborted) fail("aborted");
      if (
        result.artifactId !== artifact.artifactId ||
        result.artifactSha256 !== artifact.headSha256 ||
        result.workerSha256 !== artifact.workerSha256 ||
        result.qualificationSha256 !== artifact.qualificationSha256 ||
        !["fast", "strong", "uncertain"].includes(result.decision) ||
        !Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 1
      )
        fail("runtime-binding-mismatch");
      return Object.freeze({
        route: actual.completeness.verified ? result.decision : "strong",
        complete: actual.completeness.verified,
        confidence: actual.completeness.verified ? result.confidence : 0,
        artifactId: artifact.artifactId,
        artifactSha256,
        sourceSha256: sha256(JSON.stringify(actual.input)),
        headSha256: artifact.headSha256,
        workerSha256: artifact.workerSha256,
        qualificationSha256: artifact.qualificationSha256,
        completenessReason: actual.completeness.reason,
        calibration: "uncalibrated",
        inputTokens: result.inputTokens,
        featureElapsedMs: result.featureElapsedMs,
        runtimeOperationalElapsedMs: result.operationalElapsedMs,
        operationalElapsedMs: performance.now() - started,
        provenance: result.provenance,
      });
    },
    eligibility(
      context: RoutingContext,
      input: {
        classification: RoutingClassification;
        qualification: RoutingQualification;
        mode: RoutingMode;
      },
    ): WorkflowEligibility {
      if (disposed) return { eligibleForFast: false, reason: "disposed" };
      if (!input || !["auto", "shadow", "fast"].includes(input.mode))
        return { eligibleForFast: false, reason: "mode-ineligible" };
      const actual = extract(context, isContextManifest);
      if (!actual.completeness.verified)
        return {
          eligibleForFast: false,
          reason: "completeness-unverified",
          completenessReason: actual.completeness.reason,
        };
      const classification = input.classification;
      const qualification = input.qualification;
      const qualified =
        record(qualification) &&
        data(qualification, "qualified") === true &&
        data(qualification, "artifactId") === artifact.artifactId &&
        data(qualification, "artifactSha256") === artifactSha256 &&
        data(qualification, "qualificationSha256") ===
          artifact.qualificationSha256;
      if (
        !record(classification) ||
        data(classification, "complete") !== true ||
        data(classification, "artifactId") !== artifact.artifactId ||
        data(classification, "artifactSha256") !== artifactSha256 ||
        data(classification, "headSha256") !== artifact.headSha256 ||
        data(classification, "workerSha256") !== artifact.workerSha256 ||
        data(classification, "qualificationSha256") !==
          artifact.qualificationSha256
      )
        return {
          eligibleForFast: false,
          reason: "classification-binding-mismatch",
        };
      if (
        actual.completeness.verified &&
        data(classification, "sourceSha256") !==
          sha256(JSON.stringify(actual.input))
      )
        return { eligibleForFast: false, reason: "context-binding-mismatch" };
      return evaluateRoutingEligibility({
        ...actual.input,
        essentialFactsAvailable: actual.completeness.verified,
        artifactQualified: qualified,
        classification: {
          decision: data(classification, "route") as
            "fast" | "strong" | "uncertain",
          confidence: data(classification, "confidence") as number,
        },
      });
    },
    dispose(): Promise<void> {
      disposed = true;
      disposal ??= Promise.resolve().then(() => runtime.dispose());
      return disposal;
    },
  };
}
