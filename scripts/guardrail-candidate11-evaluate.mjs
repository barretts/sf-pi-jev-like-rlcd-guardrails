#!/usr/bin/env node
/** Explicit C11 evaluate; root owns execution. No TEST or enforcement admission. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runC11EvaluationCli } from "./guardrail-candidate10-evaluate.mjs";
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runC11EvaluationCli();
}
