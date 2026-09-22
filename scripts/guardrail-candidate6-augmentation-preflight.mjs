#!/usr/bin/env node
/** Model-free, mocked-facts eligibility check for the separate C6 TRAIN augmentation. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardrailRequest } from "../dist/guardrail.js";
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    "supplement-sha256": { type: "string" },
  },
});
if (!values["sf-pi"] || !values["sf-deps"] || !values["supplement-sha256"])
  throw new Error(
    "Required: --sf-pi DIR --sf-deps NODE_MODULES --supplement-sha256 SHA256",
  );
const sf = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const file = resolve(
  root,
  "fixtures/guardrail/candidate6/train-augmentation.json",
);
const bytes = await readFile(file);
if (sha(bytes) !== values["supplement-sha256"])
  throw new Error("C6 augmentation source hash changed");
const supplement = JSON.parse(bytes);
if (
  supplement.version !== 1 ||
  supplement.rubric !== "operation-policy-v2" ||
  !supplement.status.includes("TRAIN-only") ||
  !Array.isArray(supplement.cases) ||
  supplement.cases.length !== 6 ||
  supplement.cases.some((row) => row.split !== "train")
)
  throw new Error("Unexpected C6 augmentation shape");
const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sf,
  encoding: "utf8",
}).trim();
if (sfCommit !== supplement.sfPiSourceCommit)
  throw new Error("C6 augmentation is bound to a different sf-pi commit");

const detect = pathToFileURL(
  resolve(sf, "lib/common/sf-environment/detect.ts"),
).href;
const stub = pathToFileURL(
  resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
).href;
const dependencyParent = pathToFileURL(
  resolve(sfDeps, "__c6_augmentation_resolver__.mjs"),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let resolved;
    try {
      resolved = nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code !== "ERR_MODULE_NOT_FOUND" ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("node:")
      )
        throw error;
      resolved = nextResolve(specifier, {
        ...context,
        parentURL: dependencyParent,
      });
    }
    return resolved.url === detect
      ? { url: stub, shortCircuit: true }
      : resolved;
  },
});

const agentDir = await mkdtemp(resolve(tmpdir(), "c6-augmentation-facts-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput },
    { clearSharedSfEnvironment, restoreFromSessionEntries },
    { getJevRiskBaselineSha256 },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
  ]);
  const hostSha = getJevRiskBaselineSha256();
  const status = [];
  const seenInputs = new Set();
  for (const row of supplement.cases) {
    const cwd = "/example/project";
    clearSharedSfEnvironment(cwd);
    const org = row.observations?.org;
    if (org) {
      if (
        !org.alias ||
        !["production", "sandbox", "scratch", "developer"].includes(org.type)
      )
        throw new Error(`Invalid independent org fact: ${row.id}`);
      const env = {
        cli: { installed: true, version: "2.0.0" },
        project: { detected: true },
        config: {
          hasTargetOrg: true,
          targetOrg: org.alias,
          location: "Global",
        },
        org: {
          detected: true,
          alias: org.alias,
          username: `${org.alias.toLowerCase()}@example.test`,
          orgType: org.type,
        },
        detectedAt: 0,
      };
      restoreFromSessionEntries(
        {
          sessionManager: {
            getBranch: () => [
              { type: "custom", customType: "sf-environment", data: { env } },
            ],
          },
        },
        cwd,
      );
    }
    const input = {
      toolName: row.toolName,
      input: row.input,
      cwd,
      sessionId: `c6-augmentation-${row.id}`,
      config: readBundledConfig(),
    };
    const baseline = await evaluateSafety(input);
    const eligible = jevRiskEligible(input);
    const floor = eligible && jevRiskPolicyFloor(input, baseline);
    let prepared = false;
    let factMatched = false;
    if (eligible && !floor) {
      const riskInput = await prepareJevRiskInput(input, baseline);
      prepared =
        riskInput.version === 2 &&
        riskInput.toolName === row.toolName &&
        JSON.stringify(riskInput.input) === JSON.stringify(row.input);
      factMatched =
        !org ||
        riskInput.facts.orgs?.some(
          (fact) => fact.type === org.type && fact.guessed === false,
        ) === true;
      guardrailRequest(riskInput, RFDT_BASE_MODEL);
      const hash = sha(JSON.stringify(riskInput));
      if (seenInputs.has(hash))
        throw new Error("Duplicate augmentation model input");
      seenInputs.add(hash);
    }
    status.push({
      group: row.groupId,
      id: row.id,
      baseline: baseline?.action ?? "allow",
      eligible,
      floor,
      prepared,
      factMatched,
    });
  }
  if (sha(await readFile(file)) !== values["supplement-sha256"])
    throw new Error("C6 augmentation changed during host preflight");
  console.log(
    JSON.stringify({
      status,
      sfCommit,
      hostSha,
      supplementSha256: values["supplement-sha256"],
      modelCalls: 0,
      externalOperationsExecuted: 0,
    }),
  );
} finally {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  await rm(agentDir, { recursive: true, force: true });
}
