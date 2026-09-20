import {
  assert,
  canonical,
  validateRequest,
  type Answer,
  type ClassifierResponse,
  type Entry,
  type Rating,
  type Request,
  type TemplateVersion,
} from "./core.js";

export type ModelVisibleClassifierAnswer = { id: string } & (
  | Extract<Answer, { type: "choice" }>
  | (Extract<Answer, { type: "score" }> & { range: [number, number] })
  | {
      type: "noul";
      noul: number;
      scale: { false: 0.01; unknown: 0.5; true: 0.99 };
      calibrated?: false;
      rating?: Pick<Rating, "bins" | "probabilities" | "expected_score"> &
        Partial<Pick<Rating, "variance" | "entropy" | "logits">>;
    }
);

export interface ModelVisibleClassifierResult {
  model: string;
  advisory: true;
  calibrated: false;
  answers: ModelVisibleClassifierAnswer[];
  usage: ClassifierResponse["usage"];
  provenance: {
    backend: string | null;
    device: string | null;
    model_revision: string | null;
    template_version: TemplateVersion | null;
    usage_accounting: string | null;
    artifact?: unknown;
    native_commit?: string;
  };
}

export interface ClassifierToolResultRecord {
  id: string;
  request: Request;
  response: ClassifierResponse;
}

export interface ModelVisibleClassifierBatchResult {
  model: string;
  advisory: true;
  calibrated: false;
  records: {
    id: string;
    answers: ModelVisibleClassifierAnswer[];
    usage: ClassifierResponse["usage"];
    provenance?: ModelVisibleClassifierResult["provenance"];
  }[];
  usage: ClassifierResponse["usage"];
  provenance?: ModelVisibleClassifierResult["provenance"];
}

function probabilities(value: Record<string, number>, labels: string[]) {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === labels.length &&
      labels.every((label) => Object.hasOwn(value, label)),
    "Missing or unexpected answer probabilities",
  );
  const values = labels.map((label) => value[label]);
  assert(
    values.every(
      (probability) =>
        typeof probability === "number" && probability >= 0 && probability <= 1,
    ) &&
      Math.abs(values.reduce((sum, probability) => sum + probability, 0) - 1) <=
        1e-8,
    "Invalid answer probabilities",
  );
  return values;
}

function match(value: number, expected: number, message: string) {
  assert(Number.isFinite(value) && Math.abs(value - expected) <= 1e-8, message);
}

/** Full response details remain the caller's responsibility; this text is advisory. */
export function compactClassifierToolResult(
  value: Request,
  response: ClassifierResponse,
): ModelVisibleClassifierResult {
  const request = validateRequest(value);
  // Validate plain, bounded JSON before touching response properties or accessors.
  const result = validateRequest({
    model: request.model,
    state: response as unknown as Entry,
    questions: [{ id: "boundary", type: "noul", instructions: null }],
  }).state as unknown as ClassifierResponse;
  assert(result.model === request.model, "Classifier result model mismatch");
  assert(
    result.answers &&
      typeof result.answers === "object" &&
      !Array.isArray(result.answers) &&
      Object.keys(result.answers).length === request.questions.length &&
      request.questions.every((question) =>
        Object.hasOwn(result.answers, question.id),
      ),
    "Classifier result answer IDs mismatch",
  );
  assert(
    result.usage &&
      Number.isSafeInteger(result.usage.input_tokens) &&
      result.usage.input_tokens >= 0 &&
      result.usage.output_tokens === 0,
    "Invalid classifier result usage",
  );
  const metadata = result.metadata;
  assert(
    metadata === undefined ||
      (metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        ["v1", "v2"].includes(metadata.template_version)),
    "Invalid classifier result template",
  );
  if (metadata) {
    assert(
      typeof metadata.backend === "string" &&
        (metadata.device === undefined ||
          metadata.device === null ||
          typeof metadata.device === "string") &&
        typeof metadata.usage_accounting === "string" &&
        (metadata.model_revision === null ||
          typeof metadata.model_revision === "string"),
      "Invalid classifier result provenance",
    );
    const artifact = metadata.artifact;
    if (artifact && typeof artifact === "object" && "id" in artifact)
      assert(
        artifact.id === result.model,
        "Classifier artifact model mismatch",
      );
  }
  assert(
    !request.options?.template_version ||
      metadata?.template_version === request.options.template_version,
    "Classifier result template mismatch",
  );
  const raw = request.options?.raw_logits === true;
  const answers = request.questions.map(
    (question): ModelVisibleClassifierAnswer => {
      const answer = result.answers[question.id];
      assert(
        answer?.type === question.type,
        "Classifier result answer type mismatch",
      );
      assert(
        answer.calibrated === undefined || answer.calibrated === false,
        "Classifier result is not an uncalibrated estimate",
      );
      if (question.type === "choice" && answer.type === "choice") {
        const labels = question.criteria.map((criterion) => criterion.id);
        const distribution = probabilities(answer.probabilities, labels);
        const selected = labels.indexOf(answer.choice);
        assert(
          selected >= 0,
          "Classifier result choice is not a supplied candidate",
        );
        match(
          answer.confidence,
          distribution[selected],
          "Choice confidence mismatch",
        );
        match(
          distribution[selected],
          Math.max(...distribution),
          "Choice does not match the answer probabilities",
        );
        if (answer.ties)
          assert(
            Array.isArray(answer.ties) &&
              answer.ties.length > 0 &&
              answer.ties.every(
                (label) =>
                  labels.includes(label) &&
                  answer.probabilities[label] === answer.confidence,
              ),
            "Invalid choice ties",
          );
        return raw
          ? { ...answer, id: question.id }
          : {
              id: question.id,
              type: "choice",
              choice: answer.choice,
              confidence: answer.confidence,
              probabilities: answer.probabilities,
              ...(answer.ties && answer.ties.length > 1
                ? { ties: answer.ties }
                : {}),
            };
      }
      if (question.type === "score" && answer.type === "score") {
        const labels = question.criteria.map((_, index) => String(index));
        const distribution = probabilities(answer.probabilities, labels);
        const legend = Object.fromEntries(
          question.criteria.map((description, index) => [
            String(index),
            description,
          ]),
        );
        assert(
          canonical(answer.legend) === canonical(legend),
          "Classifier result score legend mismatch",
        );
        match(
          answer.score,
          distribution.reduce(
            (sum, probability, index) => sum + probability * index,
            0,
          ),
          "Expected score mismatch",
        );
        match(
          answer.confidence,
          Math.max(...distribution),
          "Score confidence mismatch",
        );
        return {
          ...(raw
            ? answer
            : {
                type: "score" as const,
                score: answer.score,
                confidence: answer.confidence,
                probabilities: answer.probabilities,
                legend: answer.legend,
              }),
          id: question.id,
          range: [0, question.criteria.length - 1],
        };
      }
      assert(answer.type === "noul", "Missing Noul result");
      assert(
        answer.noul >= 0.01 && answer.noul <= 0.99,
        "Invalid Noul estimate",
      );
      if (answer.rating) {
        const rating = answer.rating;
        assert(
          Array.isArray(rating.bins) &&
            Array.isArray(rating.probabilities) &&
            rating.bins.length === 9 &&
            rating.probabilities.length === 9 &&
            rating.bins.every((bin, index) => bin === index + 1),
          "Invalid Noul rating bins",
        );
        const distribution = probabilities(
          Object.fromEntries(
            rating.probabilities.map((probability, index) => [
              String(index),
              probability,
            ]),
          ),
          rating.bins.map((_, index) => String(index)),
        );
        match(
          rating.expected_score,
          distribution.reduce(
            (sum, probability, index) => sum + probability * (index + 1),
            0,
          ),
          "Noul expected rating mismatch",
        );
        match(
          answer.noul,
          Math.max(
            0.01,
            Math.min(0.99, 0.01 + ((rating.expected_score - 1) * 0.98) / 8),
          ),
          "Noul estimate mismatch",
        );
      }
      return {
        ...(raw
          ? answer
          : {
              type: "noul" as const,
              noul: answer.noul,
              ...(answer.rating
                ? {
                    rating: {
                      bins: answer.rating.bins,
                      probabilities: answer.rating.probabilities,
                      expected_score: answer.rating.expected_score,
                    },
                  }
                : {}),
            }),
        id: question.id,
        scale: { false: 0.01, unknown: 0.5, true: 0.99 },
      };
    },
  );
  const native = metadata?.native_build;
  return {
    model: result.model,
    advisory: true,
    calibrated: false,
    answers,
    usage: result.usage,
    provenance: {
      backend: metadata?.backend ?? null,
      device: (metadata?.device as string | null | undefined) ?? null,
      model_revision: metadata?.model_revision ?? null,
      template_version: metadata?.template_version ?? null,
      usage_accounting: metadata?.usage_accounting ?? null,
      ...(metadata && Object.hasOwn(metadata, "artifact")
        ? { artifact: metadata.artifact }
        : {}),
      ...(native &&
      typeof native === "object" &&
      "commit" in native &&
      typeof native.commit === "string"
        ? { native_commit: native.commit }
        : {}),
    },
  };
}

export function serializeClassifierToolResult(
  request: Request,
  response: ClassifierResponse,
): string {
  return JSON.stringify(compactClassifierToolResult(request, response));
}

export function compactClassifierBatchToolResult(
  records: ClassifierToolResultRecord[],
): ModelVisibleClassifierBatchResult {
  assert(
    Array.isArray(records) &&
      Object.getPrototypeOf(records) === Array.prototype &&
      records.length > 0 &&
      Object.getOwnPropertySymbols(records).length === 0,
    "Expected a nonempty classifier result batch",
  );
  const entries = Object.getOwnPropertyDescriptors(records);
  assert(
    Object.keys(entries).length === records.length + 1,
    "Expected a dense classifier result batch",
  );
  const ids = new Set<string>();
  const compacted = Array.from({ length: records.length }, (_, index) => {
    const entry = entries[String(index)];
    assert(entry && "value" in entry, "Batch accessors are unsupported");
    const record = entry.value;
    assert(
      record &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        (Object.getPrototypeOf(record) === Object.prototype ||
          Object.getPrototypeOf(record) === null) &&
        Object.getOwnPropertySymbols(record).length === 0,
      "Expected a plain classifier result record",
    );
    const fields = Object.getOwnPropertyDescriptors(record);
    assert(
      ["id", "request", "response"].every(
        (key) => fields[key] && "value" in fields[key],
      ),
      "Missing batch record fields or unsupported accessors",
    );
    const id = fields.id.value;
    assert(
      typeof id === "string" && id.trim().length > 0 && !ids.has(id),
      "Empty or duplicate classifier result record ID",
    );
    ids.add(id);
    return {
      id,
      result: compactClassifierToolResult(
        fields.request.value,
        fields.response.value,
      ),
    };
  });
  const first = compacted[0].result;
  assert(
    compacted.every(({ result }) => result.model === first.model),
    "Classifier result batch contains mixed models",
  );
  const shared = compacted.every(
    ({ result }) =>
      canonical(result.provenance) === canonical(first.provenance),
  );
  const inputTokens = compacted.reduce(
    (sum, { result }) => sum + result.usage.input_tokens,
    0,
  );
  assert(
    Number.isSafeInteger(inputTokens),
    "Batch logical token sum exceeds the safe integer range",
  );
  return {
    model: first.model,
    advisory: true,
    calibrated: false,
    records: compacted.map(({ id, result }) => ({
      id,
      answers: result.answers,
      usage: result.usage,
      ...(!shared ? { provenance: result.provenance } : {}),
    })),
    usage: { input_tokens: inputTokens, output_tokens: 0 },
    ...(shared ? { provenance: first.provenance } : {}),
  };
}

export function serializeClassifierBatchToolResult(
  records: ClassifierToolResultRecord[],
): string {
  return JSON.stringify(compactClassifierBatchToolResult(records));
}
