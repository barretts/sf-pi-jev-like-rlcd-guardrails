#!/usr/bin/env node
/** Explicit C11 same-F16-weight Q8 derivation; FIT precision only. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runC11Q8 } from "./guardrail-candidate10-q8.mjs";
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runC11Q8();
}
