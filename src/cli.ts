#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Classifier,
  NativeBackend,
  configFromEnv,
  type Config,
} from "./backend.js";
import type { TemplateVersion } from "./core.js";

export const cliHelp = `Jev local classifier and training workflow

  jev doctor [--model-file FILE] [--device auto|cpu|metal]
  jev warmup [--model-file FILE]
  jev eval [--input JSONL] [--split validation|train|test] [--template v2] [--output JSON]
  jev bench [--iterations 3] [--context-sizes 256,1024] [--branch-counts 1,3] [--queued-callers 1,4] [--output JSON]
  jev demo [--host 127.0.0.1] [--port 8000] [--workspace DIRECTORY]
  jev agent start [--model-file FILE] [--template-file FILE] [--port 8081] [--device metal|cpu]
  jev agent stop|status [--state-file FILE]
  jev model fetch [--model MODEL_ID] [--directory DIRECTORY] [--accept-gemma-terms]
  jev rfdt doctor [--python PATH] [--model-path DIRECTORY] [--fetch]
  jev rfdt prepare --input JSONL [--output-dir DIRECTORY] [--template v2]
  jev rfdt label --input JSONL --output JSONL --teacher-url URL --teacher-model MODEL_ID
  jev rfdt train --run DIRECTORY [--steps 8] [--model-path DIRECTORY]
  jev rfdt evaluate --run DIRECTORY [--split validation|test] [--model-path DIRECTORY]
  jev rfdt export --run DIRECTORY [--model MODEL_ID] [--output FILE] [--model-path DIRECTORY]
  jev rfdt approve --run DIRECTORY [--registry FILE]

Global classifier options: --model ID --model-file FILE --device auto|cpu|metal.
Requests stay local. Evaluation defaults to the frozen validation split. Test evaluation and model promotion are explicit.
`;

function positive(value: string | undefined, name: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`--${name} must be a positive integer`);
  return number;
}
function numbers(value: string | undefined, name: string) {
  return value === undefined
    ? undefined
    : value.split(",").map((part) => positive(part, name));
}
function version(value: string | undefined): TemplateVersion {
  if (value === undefined) return "v2";
  if (value !== "v1" && value !== "v2")
    throw new Error("--template must be v1 or v2");
  return value;
}
function required(values: Record<string, unknown>, name: string) {
  const value = values[name];
  if (typeof value !== "string" || !value)
    throw new Error(`--${name} is required`);
  return value;
}
async function output(value: unknown, file?: string) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (file) {
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(file, text);
  }
  console.log(text.trimEnd());
}

export async function runCli(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string" },
      "model-file": { type: "string" },
      device: { type: "string" },
      template: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      "output-dir": { type: "string" },
      run: { type: "string" },
      steps: { type: "string" },
      split: { type: "string" },
      "model-path": { type: "string" },
      python: { type: "string" },
      converter: { type: "string" },
      registry: { type: "string" },
      "teacher-url": { type: "string" },
      "teacher-model": { type: "string" },
      "teacher-revision": { type: "string" },
      "cache-dir": { type: "string" },
      fetch: { type: "boolean" },
      directory: { type: "string" },
      "accept-gemma-terms": { type: "boolean" },
      iterations: { type: "string" },
      "context-sizes": { type: "string" },
      "branch-counts": { type: "string" },
      "queued-callers": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      workspace: { type: "string" },
      "template-file": { type: "string" },
      binary: { type: "string" },
      "state-file": { type: "string" },
      "context-size": { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(cliHelp);
    return;
  }
  const [command, action, ...extra] = positionals;
  if (extra.length || (action && !["agent", "rfdt", "model"].includes(command)))
    throw new Error("Unexpected positional argument");
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new DOMException("Interrupted", "AbortError"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const config = () => {
    const result = configFromEnv({
      ...env,
      ...(values.model ? { JEV_MODEL_ID: values.model } : {}),
      ...(values["model-file"] ? { JEV_MODEL_FILE: values["model-file"] } : {}),
      ...(values.device ? { JEV_DEVICE: values.device } : {}),
    });
    result.templateVersion = version(values.template);
    result.advanced = true;
    return result;
  };
  try {
    if (command === "demo") {
      const { serverMain } = await import("./server.js");
      const serverArgs = [
        "host",
        "port",
        "workspace",
        "model",
        "model-file",
        "device",
      ].flatMap((name) =>
        values[name as keyof typeof values] === undefined
          ? []
          : [`--${name}`, String(values[name as keyof typeof values])],
      );
      await serverMain(serverArgs);
    } else if (command === "doctor" || command === "warmup") {
      const backend = new NativeBackend(config());
      try {
        if (command === "warmup") await backend.warmup();
        await output(
          command === "doctor" ? await backend.doctor() : backend.status,
          values.output,
        );
      } finally {
        await backend.dispose();
      }
    } else if (command === "eval") {
      const { loadQualityRecords, evaluateRecords, writeQualityReport } =
        await import("./evaluation.js");
      const split = values.split ?? "validation";
      if (!["train", "validation", "test"].includes(split))
        throw new Error("--split must be train, validation, or test");
      const records = (await loadQualityRecords(values.input)).filter(
        (record) => record.split === split,
      );
      if (!records.length) throw new Error(`No records in ${split} split`);
      const settings = config(),
        classifier = new Classifier(settings);
      try {
        const report = await evaluateRecords(
          classifier,
          records,
          version(values.template),
          { modelId: settings.modelId, signal: controller.signal },
        );
        if (values.output) await writeQualityReport(values.output, report);
        await output(report);
        if (!report.summary.gates.passed) process.exitCode = 1;
      } finally {
        await classifier.dispose();
      }
    } else if (command === "bench") {
      const { runBenchmark } = await import("./bench.js");
      const classifier = new Classifier(config());
      try {
        await output(
          await runBenchmark(classifier, {
            iterations: values.iterations
              ? positive(values.iterations, "iterations")
              : undefined,
            contextSizes: numbers(values["context-sizes"], "context-sizes"),
            branchCounts: numbers(values["branch-counts"], "branch-counts"),
            queuedCallers: numbers(values["queued-callers"], "queued-callers"),
            signal: controller.signal,
          }),
          values.output,
        );
      } finally {
        await classifier.dispose();
      }
    } else if (command === "model") {
      if (action !== "fetch") throw new Error("Use jev model fetch");
      const { fetchApprovedModel } = await import("./models.js");
      await output(
        await fetchApprovedModel(values.model ?? "google/gemma-3-1b-it", {
          directory: values.directory,
          acceptGemmaTerms: values["accept-gemma-terms"],
          signal: controller.signal,
        }),
        values.output,
      );
    } else if (command === "agent") {
      const { AgentServer, stopAgentServer, getAgentServerStatus } =
        await import("./agent-server.js");
      const state = { stateFile: values["state-file"] };
      if (action === "status") await output(await getAgentServerStatus(state));
      else if (action === "stop") {
        await stopAgentServer(state);
        await output(await getAgentServerStatus(state));
      } else if (action === "start") {
        if (values.host && values.host !== "127.0.0.1")
          throw new Error("The local agent server binds 127.0.0.1 only");
        if (values.device && !["cpu", "metal"].includes(values.device))
          throw new Error("Agent --device must be metal or cpu");
        controller.signal.throwIfAborted();
        const server = new AgentServer({
          ...state,
          modelFile: values["model-file"],
          templateFile: values["template-file"],
          binary: values.binary,
          port: positive(values.port, "port", 8081),
          contextSize: positive(values["context-size"], "context-size", 32768),
          device: values.device as "metal" | "cpu" | undefined,
          detached: true,
        });
        const stop = () => void server.stop();
        controller.signal.addEventListener("abort", stop, { once: true });
        try {
          await server.start();
          controller.signal.throwIfAborted();
          await output(await server.status());
        } catch (error) {
          await server.stop();
          throw error;
        } finally {
          controller.signal.removeEventListener("abort", stop);
        }
      } else throw new Error("Use jev agent start, stop, or status");
    } else if (command === "rfdt") {
      const rfdt = await import("./rfdt.js");
      const common = {
        modelPath: values["model-path"],
        python: values.python,
        signal: controller.signal,
      };
      if (action === "doctor")
        await output(
          await rfdt.rfdtDoctor({
            ...common,
            dataPath: values.input,
            fetch: values.fetch,
          }),
          values.output,
        );
      else if (action === "prepare")
        await output(
          await rfdt.prepareRfdt(required(values, "input"), {
            outputDir: values["output-dir"],
            templateVersion: version(values.template),
            config: config(),
            signal: controller.signal,
          }),
          values.output,
        );
      else if (action === "label")
        await output(
          await rfdt.labelRfdt(required(values, "input"), {
            outputPath: required(values, "output"),
            teacherUrl: required(values, "teacher-url"),
            teacherModel: required(values, "teacher-model"),
            teacherRevision: values["teacher-revision"],
            cacheDir: values["cache-dir"],
            signal: controller.signal,
          }),
        );
      else if (action === "train")
        await output(
          await rfdt.trainRfdt(required(values, "run"), {
            ...common,
            steps: values.steps ? positive(values.steps, "steps") : undefined,
          }),
          values.output,
        );
      else if (action === "evaluate") {
        const split = values.split ?? "validation";
        if (split !== "validation" && split !== "test")
          throw new Error("RFDT --split must be validation or test");
        const report = await rfdt.evaluateRfdt(required(values, "run"), {
          ...common,
          split,
        });
        await output(report, values.output);
        const summary = report.summary;
        const gates =
          summary && typeof summary === "object" && "gates" in summary
            ? summary.gates
            : undefined;
        if (
          !gates ||
          typeof gates !== "object" ||
          !("passed" in gates) ||
          gates.passed !== true
        )
          process.exitCode = 1;
      } else if (action === "export")
        await output(
          await rfdt.exportRfdt(required(values, "run"), {
            ...common,
            modelId: values.model,
            outputFile: values.output,
            converter: values.converter,
          }),
        );
      else if (action === "approve")
        await output(
          await rfdt.approveRfdt(required(values, "run"), {
            registryPath: values.registry,
          }),
          values.output,
        );
      else throw new Error("Unknown RFDT action; see jev --help");
    } else throw new Error(`Unknown command: ${command}; see jev --help`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
