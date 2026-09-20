import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import {
  NativeBackend,
  buildResponse,
  configFromEnv,
  preparePrompt,
} from "../dist/index.js";

// This diagnostic compares execution paths for one request. It does not load
// any quality split, select a model, or change answer scoring.
const { values } = parseArgs({
  options: {
    request: { type: "string" },
    version: { type: "string", default: "v2" },
  },
});
if (!["v1", "v2"].includes(values.version))
  throw new Error("--version must be v1 or v2");
const config = configFromEnv();
config.maxModelLen = 2048;
config.maxBatchSize = 4;
config.maxBatchTokens = 4096;
const request = values.request
  ? JSON.parse(await readFile(values.request, "utf8"))
  : {
      model: config.modelId,
      state:
        "The thermometer reads negative five degrees, which is below zero.",
      questions: [
        {
          id: "temperature",
          type: "choice",
          instructions: "Is the temperature below, equal to, or above zero?",
          criteria: [
            { id: "below", description: "Below zero" },
            { id: "equal", description: "Equal to zero" },
            { id: "above", description: "Above zero" },
          ],
        },
      ],
    };
const backend = new NativeBackend(config);
try {
  const plan = preparePrompt(request, values.version);
  const compiled = await backend.compile(plan);
  const cached = await backend.evaluate(compiled);
  const full = await backend.evaluate(compiled, undefined, true);
  let maxDifference = 0;
  let winnerAgreement = true;
  for (const branch of plan.questions)
    for (const label of branch.output_labels) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(
          cached.logits[branch.branch_id][label] -
            full.logits[branch.branch_id][label],
        ),
      );
    }
  for (const branch of plan.questions) {
    const winner = (logits) =>
      branch.output_labels.reduce((best, label) =>
        logits[branch.branch_id][label] > logits[branch.branch_id][best]
          ? label
          : best,
      );
    winnerAgreement &&= winner(cached.logits) === winner(full.logits);
  }
  console.log(
    JSON.stringify(
      {
        template_version: plan.template_version,
        compiled,
        cached,
        full,
        max_absolute_logit_difference: maxDifference,
        winner_agreement: winnerAgreement,
        cached_response: buildResponse(plan, cached.logits),
        full_response: buildResponse(plan, full.logits),
      },
      null,
      2,
    ),
  );
  if (!winnerAgreement) process.exitCode = 1;
} finally {
  await backend.dispose();
}
