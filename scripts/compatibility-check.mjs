import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Synthetic compatibility proof against the first delivered TypeScript v1 compiler.
// It does not read fixtures, launch a native backend, or execute model inference.
const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
// Optional first argument selects a source file; the default checks the current compiler.
const corePath = path.resolve(root, process.argv[2] ?? "src/core.ts");
fs.mkdirSync(path.join(root, ".build"), { recursive: true });
const reportPath = path.join(root, ".build/prompt-compatibility-current.json");
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const originalCommit = "0fef15dab99ec01d8ec091359c773b3e2db942be";
const originalSource = cp.execFileSync(
  "git",
  ["show", `${originalCommit}:src/core.ts`],
  {
    cwd: root,
    encoding: "utf8",
  },
);
const currentSource = fs.readFileSync(corePath, "utf8");
async function load(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  return import(
    "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
  );
}
const original = await load(originalSource);
const current = await load(currentSource);
const choice = {
  id: "color",
  type: "choice",
  instructions: "What color?",
  criteria: [
    { id: "red", description: null },
    { id: "blue", description: null },
  ],
};
const questionSets = [
  [choice],
  [
    {
      ...choice,
      instructions: { question: "color", metadata: [null, "blue"] },
      criteria: [
        { id: "10", description: { name: "red" } },
        { id: "2", description: ["blue", null] },
      ],
    },
  ],
  ...[2, 10, 11, 50].map((n) => [
    {
      id: "score",
      type: "score",
      instructions: "Quality level?",
      criteria: Array.from({ length: n }, (_, i) => ({ level: i })),
    },
  ]),
  [{ id: "truth", type: "noul", instructions: "Is it red?" }],
  [
    {
      id: "truth",
      type: "noul",
      instructions: ["Is it red?", { attribution: "user" }],
      criteria: { true: "explicit red", false: { denial: "not red" } },
    },
  ],
  [
    choice,
    { id: "truth", type: "noul", instructions: "Is it red?", criteria: null },
  ],
];
const contexts = [
  { state: 'The bicycle is red.\n"Quoted context"' },
  { state: { 10: "red", 2: ["bicycle", null], z: { nested: true } } },
  { messages: [{ role: "user", content: "The bicycle is red." }] },
  {
    messages: [
      { role: "system", content: "Original policy." },
      { role: "user", content: "Color?" },
      { role: "assistant", content: "Red." },
    ],
  },
];
const report = {
  schema_version: 1,
  status: "pending",
  generated_at: new Date().toISOString(),
  original_git_commit: originalCommit,
  original_core_sha256: sha256(originalSource),
  current_core_source: path.relative(root, corePath),
  current_core_sha256: sha256(currentSource),
  proof_script_sha256: sha256(fs.readFileSync(scriptPath)),
  runtime: { node: process.version, typescript: ts.version },
  counts: {
    exact_v1_plan_comparisons: 0,
    exact_v1_answer_and_usage_comparisons: 0,
  },
  expected_counts: {
    exact_v1_plan_comparisons: 72,
    exact_v1_answer_and_usage_comparisons: 432,
  },
  differences: [],
  intentional_response_metadata_differences: [],
  scope: {
    plan_comparison:
      "Exact deep equality of entire v1 Plan, including prompt literals, messages, labels, answer prefixes and cloned requests.",
    response_comparison:
      "Exact deep equality of answers and usage, plus model equality; metadata is examined separately.",
    matrix:
      "4 synthetic contexts x 9 synthetic question sets x 2 raw-logit options; scoring adds 3 logit patterns x 2 advanced modes.",
    gpu_executed: false,
    fixtures_read: false,
    limitations: [
      "Synthetic core compatibility is not rendered-native or model-quality proof.",
      "Response envelope metadata intentionally differs from the original implementation.",
      "Requires Git history containing the initial delivered commit; does not read model weights or quality records.",
    ],
  },
};
function compare(label, left, right) {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch (error) {
    report.differences.push({ label, message: error.message });
    return false;
  }
}
for (const [contextIndex, context] of contexts.entries()) {
  for (const [questionSetIndex, questions] of questionSets.entries()) {
    for (const raw of [false, true]) {
      const input = {
        model: "gemma",
        ...context,
        questions,
        ...(raw ? { options: { raw_logits: true } } : {}),
      };
      const caseId = `context=${contextIndex},questions=${questionSetIndex},raw=${raw}`;
      try {
        const a = original.preparePrompt(input);
        const b = current.preparePrompt(input, "v1");
        if (compare(`Plan:${caseId}`, b, a))
          report.counts.exact_v1_plan_comparisons++;
        for (const mode of ["uniform", "varied", "endpoint"]) {
          const logits = Object.fromEntries(
            a.questions.map((q) => [
              q.branch_id,
              Object.fromEntries(
                q.output_labels.map((label, i) => [
                  label,
                  mode === "uniform"
                    ? 10000
                    : mode === "varied"
                      ? i * 0.7 - 2
                      : i === q.output_labels.length - 1
                        ? 0
                        : -1000,
                ]),
              ),
            ]),
          );
          for (const advanced of [false, true]) {
            const ra = original.buildResponse(a, logits, 123, advanced);
            const rb = current.buildResponse(b, logits, 123, advanced);
            const label = `${caseId},logits=${mode},advanced=${advanced}`;
            const sameAnswers = compare(
              `answers:${label}`,
              rb.answers,
              ra.answers,
            );
            const sameUsage = compare(`usage:${label}`, rb.usage, ra.usage);
            const sameModel = compare(`model:${label}`, rb.model, ra.model);
            if (sameAnswers && sameUsage && sameModel)
              report.counts.exact_v1_answer_and_usage_comparisons++;
          }
        }
      } catch (error) {
        report.differences.push({
          label: caseId,
          message: error.stack ?? String(error),
        });
      }
    }
  }
}
const metadataInput = {
  model: "gemma",
  state: "The bicycle is red.",
  questions: [choice],
};
const originalPlan = original.preparePrompt(metadataInput);
const currentPlan = current.preparePrompt(metadataInput, "v1");
const metadataLogits = { 0: { A: 3, B: 1 } };
for (const [name, advanced, extra] of [
  ["basic_response_now_includes_metadata", false, {}],
  [
    "advanced_partial_extra_metadata_now_merges_with_default_fields",
    true,
    { metadata: { model_revision: "synthetic-revision" } },
  ],
]) {
  const a = original.buildResponse(
    originalPlan,
    metadataLogits,
    123,
    advanced,
    extra,
  );
  const b = current.buildResponse(
    currentPlan,
    metadataLogits,
    123,
    advanced,
    extra,
  );
  report.intentional_response_metadata_differences.push({
    name,
    original_metadata: a.metadata ?? null,
    current_metadata: b.metadata ?? null,
  });
}
compare(
  "selected source remained unchanged during proof",
  sha256(fs.readFileSync(corePath)),
  report.current_core_sha256,
);
compare("comparison counts", report.counts, report.expected_counts);
report.status = report.differences.length === 0 ? "passed" : "failed";
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      status: report.status,
      original_git_commit: originalCommit,
      current_core_source: report.current_core_source,
      current_core_sha256: report.current_core_sha256,
      proof_script_sha256: report.proof_script_sha256,
      report_path: reportPath,
      report_sha256: sha256(fs.readFileSync(reportPath)),
      counts: report.counts,
      differences: report.differences.length,
    },
    null,
    2,
  ),
);
if (report.status !== "passed") process.exitCode = 1;
