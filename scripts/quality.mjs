import { parseArgs } from "node:util";
import { Classifier, NativeBackend, configFromEnv } from "../dist/index.js";
import {
  evaluateRecords,
  loadQualityRecords,
  writeQualityReport,
} from "../dist/evaluation.js";

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "validation" },
    version: { type: "string", default: "v2" },
    dataset: { type: "string" },
    output: { type: "string" },
    context: { type: "string", default: "2048" },
  },
});
if (!["train", "validation", "test"].includes(values.split))
  throw new Error("--split must be train, validation, or test");
if (!["v1", "v2"].includes(values.version))
  throw new Error("--version must be v1 or v2");
const records = (await loadQualityRecords(values.dataset)).filter(
  (record) => record.split === values.split,
);
if (!records.length) throw new Error("No records in selected split");
const config = configFromEnv();
config.maxModelLen = Number(values.context);
config.maxBatchSize = 4;
config.maxBatchTokens = 4096;
const backend = new NativeBackend(config);
const classifier = new Classifier(config, backend);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const report = await evaluateRecords(classifier, records, values.version, {
    modelId: config.modelId,
    signal: controller.signal,
  });
  if (values.output) await writeQualityReport(values.output, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.gates.passed) process.exitCode = 1;
} finally {
  await classifier.dispose();
}
