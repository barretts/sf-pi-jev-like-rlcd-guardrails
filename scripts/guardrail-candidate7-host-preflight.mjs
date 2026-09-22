#!/usr/bin/env node
/** Model-free C7 TRAIN request/fact replay. No tool execution, model, or TEST. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = resolve(
  root,
  "fixtures/guardrail/candidate7/train-contrasts.json",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    "source-sha256": { type: "string" },
    output: { type: "string" },
    "projected-output": { type: "string" },
    "expected-sf-commit": { type: "string" },
    "expected-runtime-sha256": { type: "string" },
  },
});
if (
  !values["sf-pi"] ||
  !values["sf-deps"] ||
  !/^[a-f0-9]{64}$/.test(values["source-sha256"] ?? "")
)
  throw new Error(
    "Required: --sf-pi DIR --sf-deps NODE_MODULES --source-sha256 SHA256",
  );
const sfRoot = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const bytes = await readFile(sourceFile);
if (sha(bytes) !== values["source-sha256"])
  throw new Error("C7 TRAIN source changed");
const source = JSON.parse(bytes);
if (
  source.version !== 1 ||
  source.rubric !== "operation-policy-v2" ||
  source.trainingReady !== false ||
  source.qualification !== false ||
  source.cases?.length !== 52 ||
  source.cases.some((row) => row.split !== "train")
)
  throw new Error("Unexpected C7 TRAIN-only source");

const detectUrl = pathToFileURL(
  resolve(sfRoot, "lib/common/sf-environment/detect.ts"),
).href;
const stubUrl = pathToFileURL(
  resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
).href;
const dependencyParent = pathToFileURL(
  resolve(sfDeps, "__c7_train_resolver__.mjs"),
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
    return resolved.url === detectUrl
      ? { url: stubUrl, shortCircuit: true }
      : resolved;
  },
});

const agentDir = await mkdtemp(resolve(tmpdir(), "c7-train-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput },
    { clearSharedSfEnvironment, restoreFromSessionEntries },
    { writeLatestBrowserSnapshotRefs },
    { calculateJevRiskBaselineIdentity },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("lib/common/sf-browser-snapshot-state.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
  ]);
  const status = [];
  const examples = [];
  const inputHashes = new Set();
  for (const row of source.cases) {
    const cwd = "/example/project";
    const sessionId = `c7-train-${row.id}`;
    clearSharedSfEnvironment(cwd);
    const org = row.observations?.org;
    if (org) {
      if (
        !org.alias ||
        !["production", "sandbox", "scratch", "developer"].includes(org.type)
      )
        throw new Error(`Incomplete independent org fact: ${row.id}`);
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
    if (row.toolName === "sf_browser_click") {
      const page = row.observations.browserPage;
      const capture = writeLatestBrowserSnapshotRefs({
        sessionId,
        snapshot: page.snapshot,
        url: page.url,
      });
      if (
        capture.snapshotSha256 !== page.snapshotSha256 ||
        !capture.refs.some(
          (ref) =>
            ref.ref === row.input.ref &&
            ref.label === row.observations.browserRef.label,
        )
      )
        throw new Error(`Browser observation/capture mismatch: ${row.id}`);
    }
    const input = {
      toolName: row.toolName,
      input: row.input,
      cwd,
      sessionId,
      config: readBundledConfig(),
    };
    const baseline = await evaluateSafety(input);
    const eligible = jevRiskEligible(input);
    const floor = eligible && jevRiskPolicyFloor(input, baseline);
    let prepared = false;
    let factMatched = false;
    let reason = null;
    if (eligible && !floor) {
      try {
        const riskInput = await prepareJevRiskInput(input, baseline);
        prepared =
          riskInput.toolName === row.toolName &&
          JSON.stringify(riskInput.input) === JSON.stringify(row.input) &&
          riskInput.version >= 2;
        // The protocol intentionally does not copy alias/username into every
        // org fact. The independently resolved type and guessed=false are the
        // model-visible contract; baseline identity is checked by the host.
        factMatched =
          !org ||
          riskInput.facts.orgs?.some(
            (fact) => fact.type === org.type && fact.guessed === false,
          ) === true;
        if (prepared && factMatched) {
          const request = guardrailRequest(riskInput, RFDT_BASE_MODEL);
          const inputHash = sha(JSON.stringify(riskInput));
          if (inputHashes.has(inputHash))
            throw new Error("duplicate model-visible input");
          inputHashes.add(inputHash);
          if (request.questions?.[0]?.id !== "risk")
            throw new Error("unexpected risk question");
          examples.push({
            id: row.id,
            group_id: row.groupId,
            split: "train",
            request,
            targets: { risk: { answer: row.expected } },
            target_provenance: { risk: { source: "supplied" } },
          });
        } else reason = "request_or_fact_mismatch";
      } catch (error) {
        reason = error.message;
      }
    } else reason = !eligible ? "ineligible" : "code_owned_policy_floor";
    status.push({
      id: row.id,
      groupId: row.groupId,
      expected: row.expected,
      baseline: baseline?.action ?? "allow",
      eligible,
      floor,
      prepared,
      factMatched,
      reason,
    });
  }
  if (sha(await readFile(sourceFile)) !== values["source-sha256"])
    throw new Error("C7 TRAIN source changed during host preflight");
  const grouped = [...new Set(status.map((row) => row.groupId))].map(
    (groupId) => ({
      groupId,
      ready: status
        .filter((row) => row.groupId === groupId)
        .every(
          (row) =>
            row.eligible &&
            !row.floor &&
            row.prepared &&
            row.factMatched &&
            row.reason === null,
        ),
    }),
  );
  const hostCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfRoot,
    encoding: "utf8",
  }).trim();
  const hostRuntime = calculateJevRiskBaselineIdentity().sha256;
  const expectedCommit = values["expected-sf-commit"];
  const expectedRuntime = values["expected-runtime-sha256"];
  if (!!expectedCommit !== !!expectedRuntime)
    throw new Error(
      "Pin both --expected-sf-commit and --expected-runtime-sha256",
    );
  if (
    expectedCommit &&
    (hostCommit !== expectedCommit || hostRuntime !== expectedRuntime)
  )
    throw new Error("Host commit/runtime changed from requested pin");
  const receipt = {
    version: 1,
    purpose: "candidate7_train_host_preflight",
    qualification: false,
    trainingReady: false,
    hostIdentityPinned: Boolean(expectedCommit),
    modelCalls: 0,
    externalOperationsExecuted: 0,
    heldOutTestRead: false,
    source: {
      file: sourceFile,
      sha256: values["source-sha256"],
      preflightScriptSha256: sha(
        await readFile(fileURLToPath(import.meta.url)),
      ),
      mockDiscoveryStubSha256: sha(
        await readFile(
          resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
        ),
      ),
      scorerDistributionSha256: sha(
        await readFile(resolve(root, "dist/guardrail.js")),
      ),
      scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      sfPiCommit: hostCommit,
      sfPiRuntimeSha256: hostRuntime,
    },
    counts: {
      rows: status.length,
      groups: grouped.length,
      preparedRows: status.filter(
        (row) => row.prepared && row.factMatched && !row.reason,
      ).length,
      readyGroups: grouped.filter((group) => group.ready).length,
    },
    groups: grouped,
    status,
  };
  if (values["projected-output"]) {
    if (
      grouped.some((group) => !group.ready) ||
      examples.length !== source.cases.length
    )
      throw new Error("Cannot project incomplete or code-floored TRAIN groups");
    const projected = resolve(values["projected-output"]);
    const rel = relative(resolve(root, ".build/guardrail"), projected);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith(sep) ||
      !projected.endsWith(".jsonl")
    )
      throw new Error(
        "Projected output must be a fresh JSONL path under .build/guardrail",
      );
    const projectedBytes = Buffer.from(
      examples.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    await mkdir(dirname(projected), { recursive: true });
    await writeFile(projected, projectedBytes, { flag: "wx", mode: 0o600 });
    receipt.projectedTrain = {
      file: projected,
      sha256: sha(projectedBytes),
      rows: examples.length,
      groups: grouped.length,
      baseModel: RFDT_BASE_MODEL,
      scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    };
  }
  if (values.output) {
    const output = resolve(values.output);
    const rel = relative(resolve(root, ".build/guardrail"), output);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith(sep) ||
      !output.endsWith(".json")
    )
      throw new Error(
        "Output must be a fresh JSON path under .build/guardrail",
      );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(receipt));
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
}
