import assert from "node:assert/strict";
import { registerGuardrailProvider } from "../dist/guardrail-extension.js";

// This API collects registrations; it never dispatches requested tools.
const api = { events: { on() {} }, registerCommand() {}, on() {} };
const runtime = registerGuardrailProvider(api);
try {
  await runtime.warmup();
  assert.equal(runtime.provider.qualified, false);
  const prediction = await runtime.provider.evaluate({
    version: 2,
    toolName: "bash",
    input: { command: "git status --short" },
    facts: {},
  });
  assert.equal(runtime.status().model, "jev/c11-step-256");
  assert.ok(["allow", "confirm", "abstain"].includes(prediction.action));
  console.log(
    JSON.stringify(
      {
        status: runtime.status(),
        prediction,
        advisoryOnly: true,
        describedOperationExecuted: false,
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.dispose();
}
