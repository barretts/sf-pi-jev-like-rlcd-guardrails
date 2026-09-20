import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { configFromEnv, NativeBackend, Classifier } from "../dist/index.js";
import { createServer } from "../dist/server.js";
const config = configFromEnv();
config.maxModelLen = 2048;
config.maxBatchSize = 4;
config.maxBatchTokens = 4096;
config.advanced = true;
const backend = new NativeBackend(config);
const app = await createServer(config, new Classifier(config, backend));
try {
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = {
    model: config.modelId,
    state: "Mia owns a red bicycle.",
    questions: {
      color: {
        type: "choice",
        instructions: "What color is Mia's bicycle?",
        criteria: { red: null, blue: null },
      },
    },
    options: { raw_logits: true },
  };
  const post = (body, signal, path = "/v1/classifier") =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  const response = await post(request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answers.color.choice, "red");
  assert.equal(result.usage.output_tokens, 0);
  assert.ok(result.answers.color.logits);
  const alias = await post(request, undefined, "/v1/systemone");
  assert.equal(alias.status, 200);
  const invalid = await post({ ...request, model: "unknown" });
  assert.equal(invalid.status, 422);
  const badChat = await post({
    model: config.modelId,
    messages: [{ role: "user", content: "A red bicycle." }],
    questions: request.questions,
  });
  assert.equal(badChat.status, 422);
  const abort = new AbortController();
  const cancelled = post(
    {
      ...request,
      state: "A red bicycle. " + "Additional neutral context. ".repeat(250),
    },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(cancelled);
  const recovery = await post(request);
  assert.equal(recovery.status, 200);
  assert.equal((await recovery.json()).answers.color.choice, "red");
  const health = await (await fetch(url + "/health")).json();
  assert.equal(health.status, "ready");
  const child = backend.child;
  assert.ok(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const unavailable = await fetch(url + "/health");
  assert.equal(unavailable.status, 503);
  const restarted = await post(request);
  assert.equal(restarted.status, 200);
  assert.equal((await restarted.json()).answers.color.choice, "red");
  const proof = {
    transport: "real localhost HTTP",
    model: config.modelId,
    result,
    alias_status: alias.status,
    invalid_model_status: invalid.status,
    unsupported_history_status: badChat.status,
    disconnect: "fetch aborted; subsequent request succeeded",
    health,
    backend_crash_health_status: unavailable.status,
    backend_restart_status: restarted.status,
  };
  console.log(JSON.stringify(proof, null, 2));
  await writeFile(
    new URL("../.build/http-proof.json", import.meta.url),
    JSON.stringify(proof, null, 2),
  );
} finally {
  await app.close();
}
