import { createHash } from "node:crypto";
import {
  assert,
  canonical,
  validateRequest,
  type ClassifierResponse,
  type Entry,
  type Request,
} from "./core.js";

export const DEVELOPER_RECIPE_VERSION = "developer-diagnostics-v1";

export interface DeveloperRecipeCandidate {
  id: string;
  description: Entry;
}

export interface DeveloperRecipeInput {
  task: string;
  evidence: Entry;
  candidates?: DeveloperRecipeCandidate[];
  proposition?: {
    kind: "original_failure" | "verified_repair";
    statement: string;
  };
}

export interface DeveloperRecipeResult {
  recipe: typeof DEVELOPER_RECIPE_VERSION;
  model: string;
  advisory: true;
  calibrated: false;
  diagnosis: { candidate: string; description: Entry };
  evidence_sufficiency: { estimate: number; range: [0, 2] };
  evidence_status: {
    kind: "original_failure" | "verified_repair";
    proposition: string;
    estimate: number;
    unknown_reference: 0.5;
    interpretation: "uncalibrated estimate; not verification";
  };
  answers: ClassifierResponse["answers"];
  usage: ClassifierResponse["usage"];
  metadata?: ClassifierResponse["metadata"];
  metrics?: ClassifierResponse["metrics"];
  provenance: {
    request_sha256: string;
    task_sha256: string;
    evidence_sha256: string;
    model: string;
    template_version: "v2";
  };
}

const DEFAULT_CANDIDATES: readonly DeveloperRecipeCandidate[] = [
  {
    id: "type-contract",
    description:
      "A value, argument, return type, or API shape violates its declared contract. Inspect the reported type and its producer or consumer.",
  },
  {
    id: "async-lifecycle",
    description:
      "Asynchronous work, cancellation, cleanup, or initialization completes in the wrong order. Inspect ownership and await boundaries.",
  },
  {
    id: "iteration-boundary",
    description:
      "A loop, index, range, or empty-input boundary includes or excludes the wrong item. Inspect the failing boundary case.",
  },
  {
    id: "configuration",
    description:
      "A missing or incompatible setting, dependency, environment value, or build option blocks execution. Inspect the named configuration.",
  },
  {
    id: "test-expectation",
    description:
      "The supplied specification establishes that the test expectation or fixture is incorrect. Inspect the assertion against that specification.",
  },
  {
    id: "insufficient-evidence",
    description:
      "The supplied evidence does not identify a supported cause. Obtain the relevant failing command, diagnostic, source, or specification before choosing a repair.",
  },
  {
    id: "multiple-causes",
    description:
      "The evidence establishes multiple independent causes rather than one explanation. Inspect each separately reported failure.",
  },
];

const DEFAULT_PROPOSITION = {
  kind: "original_failure" as const,
  statement:
    "The supplied evidence explicitly records a failing build, test, or development command.",
};

// Reuse the public request boundary before reading or cloning caller evidence.
function plainJson(value: unknown): Entry {
  return validateRequest({
    model: "google/gemma-3-1b-it",
    state: value,
    questions: [{ id: "boundary", type: "noul", instructions: null }],
  }).state!;
}

function normalizeInput(value: DeveloperRecipeInput): DeveloperRecipeInput {
  const input = plainJson(value) as unknown as DeveloperRecipeInput;
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    "Expected developer recipe input",
  );
  for (const key of Object.keys(input))
    assert(
      ["task", "evidence", "candidates", "proposition"].includes(key),
      "Unknown developer recipe field",
      key,
    );
  assert(
    typeof input.task === "string" && input.task.trim().length,
    "Developer task must be nonempty",
    "task",
  );
  assert(
    Object.hasOwn(input, "evidence") &&
      (input.evidence === null ||
        typeof input.evidence === "string" ||
        typeof input.evidence === "object"),
    "Evidence must be text, JSON object, array, or null",
    "evidence",
  );
  if (input.proposition !== undefined) {
    assert(
      input.proposition &&
        typeof input.proposition === "object" &&
        !Array.isArray(input.proposition),
      "Expected evidence proposition",
      "proposition",
    );
    for (const key of Object.keys(input.proposition))
      assert(
        ["kind", "statement"].includes(key),
        "Unknown proposition field",
        "proposition." + key,
      );
    assert(
      ["original_failure", "verified_repair"].includes(
        input.proposition.kind,
      ) &&
        typeof input.proposition.statement === "string" &&
        input.proposition.statement.trim().length,
      "Expected proposition kind and nonempty statement",
      "proposition",
    );
  }
  return input;
}

export function buildDeveloperRecipeRequest(
  value: DeveloperRecipeInput,
  model = "google/gemma-3-1b-it",
): Request {
  const input = normalizeInput(value);
  const proposition = input.proposition ?? DEFAULT_PROPOSITION;
  return validateRequest({
    model,
    state: { user_task: input.task, evidence: input.evidence },
    questions: [
      {
        id: "diagnosis",
        type: "choice",
        instructions:
          "Choose the diagnosis or next inspection supported by the supplied developer evidence. Distinguish the actual blocking failure from unrelated warnings. A suggested repair is not evidence of its cause or success. Choose insufficient-evidence when no candidate cause is established, and multiple-causes only for separately established causes.",
        criteria: input.candidates ?? DEFAULT_CANDIDATES,
      },
      {
        id: "evidence_sufficiency",
        type: "score",
        instructions:
          "Rate how well the supplied evidence supports identifying the cause of the developer failure. Consider diagnostics, relevant source, and the requested behavior. Do not credit a proposed patch or a confidence claim as proof.",
        criteria: [
          "No relevant observed failure or information identifying its cause is supplied.",
          "A relevant failure is observed, but its cause still requires missing source, reproduction, or specification.",
          "The relevant observed failure and supplied source or specification establish a specific cause or multiple independent causes.",
        ],
      },
      {
        id: "evidence_status",
        type: "noul",
        instructions: `Evaluate this exact proposition using only the supplied evidence: ${proposition.statement}\nFor a verified repair, require a successful rerun covering the original failing case after the change. A proposed patch, an assistant's completion claim, or a passing unrelated check does not establish a repair. Missing observations are unknown rather than false. An explicit observation contradicting the proposition supports false.`,
        criteria: {
          true: "The supplied observations establish the exact proposition.",
          false:
            "The supplied observations establish a contradiction of the exact proposition.",
        },
      },
    ],
    options: { template_version: "v2" },
  });
}

const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export function renderDeveloperRecipeResult(
  value: DeveloperRecipeInput,
  response: ClassifierResponse,
): DeveloperRecipeResult {
  const input = normalizeInput(value);
  const result = plainJson(response) as unknown as ClassifierResponse;
  assert(
    typeof result.model === "string" && result.model.length,
    "Recipe result model must be nonempty",
  );
  const request = buildDeveloperRecipeRequest(input, result.model);
  const diagnosis = result.answers?.diagnosis;
  const sufficiency = result.answers?.evidence_sufficiency;
  const status = result.answers?.evidence_status;
  assert(diagnosis?.type === "choice", "Missing choice diagnosis");
  assert(sufficiency?.type === "score", "Missing evidence sufficiency score");
  assert(status?.type === "noul", "Missing evidence status judgment");
  assert(
    Number.isFinite(sufficiency.score) &&
      sufficiency.score >= 0 &&
      sufficiency.score <= 2 &&
      Number.isFinite(status.noul) &&
      status.noul >= 0.01 &&
      status.noul <= 0.99,
    "Invalid recipe estimates",
  );
  const candidates = request.questions[0];
  assert(candidates.type === "choice", "Missing recipe candidates");
  const selected = candidates.criteria.find(
    (candidate) => candidate.id === diagnosis.choice,
  );
  assert(selected, "Diagnosis is not a supplied candidate");
  assert(
    result.metadata?.template_version === "v2",
    "Recipe result must use v2",
  );
  assert(
    result.usage &&
      Number.isSafeInteger(result.usage.input_tokens) &&
      result.usage.input_tokens >= 0 &&
      result.usage.output_tokens === 0,
    "Invalid classifier usage",
  );
  const proposition = input.proposition ?? DEFAULT_PROPOSITION;
  return {
    recipe: DEVELOPER_RECIPE_VERSION,
    model: result.model,
    advisory: true,
    calibrated: false,
    diagnosis: { candidate: selected.id, description: selected.description },
    evidence_sufficiency: { estimate: sufficiency.score, range: [0, 2] },
    evidence_status: {
      kind: proposition.kind,
      proposition: proposition.statement,
      estimate: status.noul,
      unknown_reference: 0.5,
      interpretation: "uncalibrated estimate; not verification",
    },
    answers: result.answers,
    usage: result.usage,
    ...(result.metadata ? { metadata: result.metadata } : {}),
    ...(result.metrics ? { metrics: result.metrics } : {}),
    provenance: {
      request_sha256: digest({
        recipe: DEVELOPER_RECIPE_VERSION,
        model: request.model,
        state: request.state,
        questions: request.questions,
        options: request.options,
      }),
      task_sha256: digest(input.task),
      evidence_sha256: digest(input.evidence),
      model: result.model,
      template_version: "v2",
    },
  };
}

export function formatDeveloperRecipeResult(
  result: DeveloperRecipeResult,
): string {
  return JSON.stringify(result);
}
