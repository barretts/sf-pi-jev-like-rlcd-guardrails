import { createEventBus } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { InferenceAdapter } from "../src/backend.js";
import type { Plan } from "../src/core.js";
import { C11 } from "../src/guardrail-selection.js";
import type { ApprovedArtifact } from "../src/models.js";

export const safeInput = {
  version: 2 as const,
  toolName: "bash",
  input: { command: "git status --short" },
  facts: {},
};
export function c11Artifact(): ApprovedArtifact {
  return {
    id: C11.modelId,
    sha256: C11.modelSha256,
    size: C11.modelBytes,
    revision: C11.baseRevision,
    base_model: C11.baseModel,
    template_version: "v2",
    training_run: C11.trainingRun,
    file: "/fixture/model.gguf",
    roles: ["classifier"],
    license: "gemma",
  };
}
export function worker(
  warmup: () => Promise<void> = async () => {},
  allowScore: () => number = () => 0.98,
): InferenceAdapter {
  return {
    warmup: vi.fn(warmup),
    compile: vi.fn(async (plan) => plan),
    evaluate: vi.fn(async (compiled) => ({
      logits: Object.fromEntries(
        (compiled as Plan).questions.map((branch) => [
          branch.branch_id,
          Object.fromEntries(
            branch.output_labels.map((label, index) => [
              label,
              Math.log(index === 0 ? allowScore() : 1 - allowScore()),
            ]),
          ),
        ]),
      ),
      input_tokens: 100,
      metrics: {},
    })),
    dispose: vi.fn(async () => {}),
  };
}
export function harness() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const pi: any = {
    events: createEventBus(),
    on: (name: string, handler: any) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  const context: any = {
    ui: { notify: vi.fn(), confirm: vi.fn(), select: vi.fn() },
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, context);
  };
  return { pi, handlers, commands, context, emit };
}
export function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
