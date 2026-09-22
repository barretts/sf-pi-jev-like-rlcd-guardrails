#!/usr/bin/env node
/** Explicit fixed-.5 VALID functionality benchmark; no TEST, admission, or enforcement.
 * Uses the normal pinned native evaluation manifest, verified F16/Q8 export,
 * actual CAL digest and real sf-pi shadow replay. CAL admission may fail.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  evaluateC10Diagnostic,
  validateC10Manifest,
} from "./guardrail-candidate10-evaluate.mjs";
export async function runDiagnosticValid({ manifest, manifestSha256, output }) {
  if (
    !isAbsolute(manifest ?? "") ||
    !isAbsolute(output ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")
  )
    throw new Error(
      "Required absolute --manifest, --output and exact --manifest-sha256",
    );
  const stat = await lstat(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1048576)
    throw new Error("Bounded regular evaluation manifest required");
  const bytes = await readFile(manifest);
  if (createHash("sha256").update(bytes).digest("hex") !== manifestSha256)
    throw new Error("Evaluation manifest changed");
  return evaluateC10Diagnostic(validateC10Manifest(JSON.parse(bytes)), output);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      "manifest-sha256": { type: "string" },
      output: { type: "string" },
    },
  });
  const result = await runDiagnosticValid({
    manifest: values.manifest,
    manifestSha256: values["manifest-sha256"],
    output: values.output,
  });
  console.log(
    JSON.stringify({
      status: result.status,
      qualified: false,
      enforcementEligible: false,
      candidateAdmission: false,
      diagnosticOnly: true,
      fixedMinimumAllowScore: 0.5,
      calAdmissionAccepted: result.selection?.accepted,
      calAdmissionReason: result.selection?.reason,
      wholeAccuracy: result.validation?.fullAccuracy,
      eligibleAccuracy: result.validation?.modelEligibleAccuracy,
      metrics: result.validation?.metrics,
      failures: result.failures,
    }),
  );
  if (result.status !== "diagnostic_valid_complete") process.exitCode = 1;
}
