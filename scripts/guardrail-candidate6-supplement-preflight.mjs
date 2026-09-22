#!/usr/bin/env node
/** Project the C6 TRAIN supplement through the current sf-pi host without a model or tool execution. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { RFDT_BASE_MODEL, RFDT_BASE_REVISION } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSupplement = resolve(
  root,
  "fixtures/guardrail/candidate6/train-supplement.json",
);
const outputRoot = resolve(root, ".build/guardrail");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitHead = (directory) =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();

function inside(file, directory) {
  const rel = relative(directory, file);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validateSupplement(supplement) {
  if (
    supplement?.version !== 1 ||
    supplement.rubric !== "operation-policy-v2" ||
    !String(supplement.status).includes("TRAIN-only") ||
    !Array.isArray(supplement.cases) ||
    supplement.cases.length !== 18
  )
    throw new Error("C6 source is not the expected 18-row TRAIN supplement");
  const ids = new Set();
  const groups = new Map();
  const families = new Map();
  let allow = 0;
  let confirm = 0;
  for (const row of supplement.cases) {
    if (
      typeof row.id !== "string" ||
      !row.id.startsWith("c6-supp-") ||
      ids.has(row.id) ||
      typeof row.groupId !== "string" ||
      !row.groupId.startsWith("c6-supp-") ||
      row.split !== "train" ||
      !["allow", "confirm"].includes(row.expected) ||
      !["bash", "herdr_pane", "data360_api"].includes(row.toolName) ||
      row.input === null ||
      typeof row.input !== "object" ||
      !Array.isArray(row.fixturePreconditions) ||
      row.fixturePreconditions.length === 0 ||
      !Array.isArray(row.sourceEvidence) ||
      row.sourceEvidence.length === 0 ||
      row.observations === null ||
      typeof row.observations !== "object"
    )
      throw new Error(`Invalid C6 TRAIN source row ${row?.id}`);
    ids.add(row.id);
    const labels = groups.get(row.groupId) ?? new Set();
    labels.add(row.expected);
    groups.set(row.groupId, labels);
    families.set(row.family, (families.get(row.family) ?? 0) + 1);
    if (row.expected === "allow") allow++;
    else confirm++;
  }
  if (
    groups.size !== 8 ||
    groups.has("c6-supp-shell-python-unlink") ||
    [...groups.values()].some(
      (labels) =>
        labels.size !== 2 || !labels.has("allow") || !labels.has("confirm"),
    ) ||
    allow !== 9 ||
    confirm !== 9 ||
    families.get("shell") !== 2 ||
    [...["salesforce", "data360", "soql", "canvas"]].some(
      (family) => families.get(family) !== 4,
    )
  )
    throw new Error(
      "C6 TRAIN source lost matched contrasts or family coverage",
    );
  return {
    groups: groups.size,
    labels: { allow, confirm },
    families: Object.fromEntries(families),
  };
}

function configureHostResolver(sf, sfDeps) {
  const detectUrl = pathToFileURL(
    resolve(sf, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stubUrl = pathToFileURL(
    resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
  ).href;
  const dependenciesParent = pathToFileURL(
    resolve(sfDeps, "__c6_supplement_resolver__.mjs"),
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
          parentURL: dependenciesParent,
        });
      }
      return resolved.url === detectUrl
        ? { url: stubUrl, shortCircuit: true }
        : resolved;
    },
  });
}

function restoreMockOrg(
  row,
  cwd,
  clearSharedSfEnvironment,
  restoreFromSessionEntries,
) {
  clearSharedSfEnvironment(cwd);
  const org = row.observations?.org;
  if (!org) return;
  if (
    !["production", "sandbox", "scratch", "developer"].includes(org.type) ||
    typeof org.alias !== "string" ||
    !org.alias
  )
    throw new Error(`Incomplete independently authored org fact: ${row.id}`);
  const env = {
    cli: { installed: true, version: "2.0.0" },
    project: { detected: true },
    config: { hasTargetOrg: true, targetOrg: org.alias, location: "Global" },
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

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      supplement: { type: "string" },
      "supplement-sha256": { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  if (
    !values["sf-pi"] ||
    !values["sf-deps"] ||
    !values["supplement-sha256"] ||
    !values["output-dir"]
  )
    throw new Error(
      "Required: --sf-pi DIR --sf-deps NODE_MODULES_DIR --supplement-sha256 PINNED_SHA256 --output-dir FRESH_BUILD_DIR [--supplement JSON]",
    );
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const supplementPath = resolve(values.supplement ?? defaultSupplement);
  const outputDir = resolve(values["output-dir"]);
  const pinnedSha256 = values["supplement-sha256"].toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(pinnedSha256))
    throw new Error("--supplement-sha256 must be a full SHA-256 digest");
  if (
    !inside(outputDir, outputRoot) ||
    !basename(outputDir).startsWith("candidate-6-supplement-preflight-")
  )
    throw new Error(
      "Output must be a fresh candidate-6-supplement-preflight-* directory under .build/guardrail",
    );
  if (!(await stat(sfDeps)).isDirectory())
    throw new Error("--sf-deps must be an installed node_modules directory");
  const supplementBytes = await readFile(supplementPath);
  if (sha(supplementBytes) !== pinnedSha256)
    throw new Error("Pinned C6 supplement SHA-256 mismatch");
  const supplement = JSON.parse(supplementBytes);
  const counts = validateSupplement(supplement);
  const sfCommit = gitHead(sf);
  if (supplement.sfPiSourceCommit !== sfCommit)
    throw new Error("C6 supplement is bound to a different sf-pi commit");
  const [sfLockBytes, sfDepsLockBytes, scriptBytes, scorerBytes, stubBytes] =
    await Promise.all([
      readFile(resolve(sf, "package-lock.json")),
      readFile(resolve(sfDeps, ".package-lock.json")),
      readFile(fileURLToPath(import.meta.url)),
      readFile(resolve(root, "dist/guardrail.js")),
      readFile(resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs")),
    ]);
  configureHostResolver(sf, sfDeps);
  const agentDir = await mkdtemp(resolve(tmpdir(), "c6-supplement-facts-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput },
      { clearSharedSfEnvironment, restoreFromSessionEntries },
      { getJevRiskBaselineSha256, calculateJevRiskBaselineIdentity },
    ] = await Promise.all([
      sfImport("extensions/sf-guardrail/lib/config.ts"),
      sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
      sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
      sfImport("lib/common/sf-environment/shared-runtime.ts"),
      sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ]);
    const hostSourceSha256 = getJevRiskBaselineSha256();
    const examples = [];
    const riskInputHashes = new Set();
    const baselineActions = { allow: 0, confirm: 0, block: 0 };
    for (const row of supplement.cases) {
      const cwd = "/example/project";
      restoreMockOrg(
        row,
        cwd,
        clearSharedSfEnvironment,
        restoreFromSessionEntries,
      );
      const input = {
        toolName: row.toolName,
        input: row.input,
        cwd,
        sessionId: `c6-supplement-${row.id}`,
        config: readBundledConfig(),
      };
      const baseline = await evaluateSafety(input);
      baselineActions[baseline?.action ?? "allow"]++;
      if (!jevRiskEligible(input) || jevRiskPolicyFloor(input, baseline))
        throw new Error(
          `C6 TRAIN row is ineligible or exact-floored: ${row.id}`,
        );
      const riskInput = await prepareJevRiskInput(input, baseline);
      if (
        riskInput.version !== 2 ||
        riskInput.toolName !== row.toolName ||
        JSON.stringify(riskInput.input) !== JSON.stringify(row.input)
      )
        throw new Error(
          `C6 host changed the complete TRAIN request: ${row.id}`,
        );
      const org = row.observations?.org;
      if (
        org &&
        !riskInput.facts.orgs?.some(
          (fact) => fact.type === org.type && fact.guessed === false,
        )
      )
        throw new Error(`C6 verified org fact mismatch: ${row.id}`);
      const riskInputHash = sha(JSON.stringify(riskInput));
      if (riskInputHashes.has(riskInputHash))
        throw new Error(`Duplicate C6 TRAIN model input: ${row.id}`);
      riskInputHashes.add(riskInputHash);
      examples.push({
        id: row.id,
        group_id: row.groupId,
        split: "train",
        request: guardrailRequest(riskInput, RFDT_BASE_MODEL),
        targets: { risk: { answer: row.expected } },
        target_provenance: { risk: { source: "supplied" } },
      });
    }
    if (
      examples.length !== 18 ||
      calculateJevRiskBaselineIdentity().sha256 !== hostSourceSha256 ||
      gitHead(sf) !== sfCommit ||
      sha(await readFile(supplementPath)) !== pinnedSha256 ||
      sha(await readFile(fileURLToPath(import.meta.url))) !== sha(scriptBytes)
    )
      throw new Error(
        "C6 source or current sf-pi host changed during preflight",
      );
    const datasetBytes = `${examples.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const datasetPath = resolve(outputDir, "train.jsonl");
    const receiptPath = resolve(outputDir, "receipt.json");
    const receipt = {
      version: 1,
      purpose: "candidate6_supplement_train_only_host_preflight",
      qualification: false,
      trainingReady: false,
      blindSplitScreened: false,
      humanLabelReviewed: false,
      modelCalls: 0,
      externalOperationsExecuted: 0,
      mockedHostFacts: true,
      trainRows: examples.length,
      trainGroups: counts.groups,
      validationRows: 0,
      testRows: 0,
      labels: counts.labels,
      families: counts.families,
      baselineActions,
      dataset: { file: datasetPath, sha256: sha(datasetBytes) },
      source: {
        supplementFile: supplementPath,
        supplementSha256: pinnedSha256,
        sfPiCommit: sfCommit,
        sfPiRuntimeSha256: hostSourceSha256,
        sfPackageLockSha256: sha(sfLockBytes),
        sfDependenciesDirectory: sfDeps,
        sfDependenciesLockSha256: sha(sfDepsLockBytes),
        mockDiscoveryStubSha256: sha(stubBytes),
        scorerDistributionSha256: sha(scorerBytes),
        scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        preparationScriptSha256: sha(scriptBytes),
        rfdtBaseModel: RFDT_BASE_MODEL,
        rfdtBaseRevision: RFDT_BASE_REVISION,
      },
    };
    await mkdir(outputRoot, { recursive: true });
    await mkdir(outputDir, { recursive: false });
    try {
      await writeFile(datasetPath, datasetBytes, { mode: 0o600, flag: "wx" });
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await rm(outputDir, { recursive: true, force: true });
      throw error;
    }
    console.log(
      JSON.stringify({
        trainRows: receipt.trainRows,
        trainGroups: receipt.trainGroups,
        trainingReady: false,
        baselineActions,
        datasetSha256: receipt.dataset.sha256,
        receipt: receiptPath,
      }),
    );
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

await main();
