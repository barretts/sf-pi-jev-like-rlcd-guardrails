import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  Classifier,
  NativeBackend,
  configFromEnv,
  preparePrompt,
  buildResponse,
} from "../dist/index.js";
const config = configFromEnv();
config.maxModelLen = 2048;
config.maxBatchSize = 4;
config.maxBatchTokens = 4096;
config.advanced = true;
const backend = new NativeBackend(config);
const request = {
  model: config.modelId,
  state: "Mia owns a red bicycle. Her dog is named Max.",
  options: { raw_logits: true },
  questions: [
    {
      id: "color",
      type: "choice",
      instructions: "What color is Mia's bicycle?",
      criteria: [
        { id: "red", description: null },
        { id: "blue", description: null },
      ],
    },
    {
      id: "support",
      type: "score",
      instructions:
        "How well does the context support that Mia owns a bicycle?",
      criteria: ["Unsupported", "Partly supported", "Fully supported"],
    },
    { id: "dog", type: "noul", instructions: "Is Mia's dog named Max?" },
  ],
};
try {
  await backend.warmup();
  const plan = preparePrompt(request),
    compiled = await backend.compile(plan);
  const cached = await backend.evaluate(compiled),
    full = await backend.evaluate(compiled, undefined, true);
  const a = buildResponse(plan, cached.logits, cached.input_tokens, true),
    b = buildResponse(plan, full.logits, full.input_tokens, true);
  let maxDifference = 0;
  for (const branch of plan.questions) {
    const row = cached.logits[branch.branch_id],
      other = full.logits[branch.branch_id];
    const probs = (v) => {
      const max = Math.max(...v),
        w = v.map((x) => Math.exp(x - max)),
        sum = w.reduce((a, b) => a + b, 0);
      return w.map((x) => x / sum);
    };
    const p = probs(Object.values(row)),
      q = probs(Object.values(other));
    for (let i = 0; i < p.length; i++)
      maxDifference = Math.max(maxDifference, Math.abs(p[i] - q[i]));
  }
  await writeFile(
    new URL("../.build/cache-debug.json", import.meta.url),
    JSON.stringify({ cached, full }, null, 2),
  );
  await writeFile(
    new URL("../.build/template-proof.json", import.meta.url),
    JSON.stringify(
      { template: backend.template, branches: plan.questions, compiled },
      null,
      2,
    ),
  );
  assert.ok(
    maxDifference <= 1e-5,
    `Cache probability difference ${maxDifference}`,
  );
  assert.equal(cached.input_tokens, full.input_tokens);
  assert.equal(a.usage.output_tokens, 0);
  assert.ok(cached.metrics.prefix_tokens > 0);
  assert.ok(
    cached.metrics.computed_prompt_tokens < full.metrics.computed_prompt_tokens,
  );
  const classifier = new Classifier(config, backend);
  const chat = await classifier.classify({
    model: config.modelId,
    messages: [
      {
        role: "user",
        content: "I was charged twice. Please refund the duplicate charge.",
      },
      { role: "assistant", content: "I understand." },
    ],
    questions: [
      {
        id: "refund",
        type: "noul",
        instructions: "Does the customer ask for a refund?",
      },
    ],
  });
  assert.ok(chat.answers.refund.noul >= 0.01);
  await writeFile(
    new URL("../.build/template-proof.json", import.meta.url),
    JSON.stringify(
      { template: backend.template, branches: plan.questions, compiled },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        model: config.modelId,
        device: config.device,
        max_cache_probability_difference: maxDifference,
        cached: cached.metrics,
        full: full.metrics,
        answers: a.answers,
        chat_answers: chat.answers,
      },
      null,
      2,
    ),
  );
} finally {
  await backend.dispose();
}
