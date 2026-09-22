#!/usr/bin/env node
/** Prepare a TRAIN-only RFDT systems smoke, never a candidate-5 admission. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { RFDT_BASE_MODEL, RFDT_BASE_REVISION } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplementPath = resolve(
  root,
  "fixtures/guardrail/candidate5/train-supplement.json",
);
const treePath = resolve(
  root,
  "fixtures/guardrail/candidate5/accounts-tree.json",
);
const policyPath = resolve(root, "fixtures/guardrail/candidate5/POLICY.md");
const officialRun = resolve(root, ".build/guardrail/candidate-5");
const reviewedSupplementSha256 =
  "a53936a41c035ae249ef2bda017cc36704be9e37e1ab5f7b6e8ed5e9ef849446";
const reviewedCorpusSha256 =
  "bb4ed147933c076111b127e6a5433c6ce7ea54cc43befb7d384ddb54681e6309";
const originalWeightsSha256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const inDirectory = (file, directory) => {
  const rel = relative(directory, file);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

function validateSupplement(supplement, digest) {
  if (
    digest !== reviewedSupplementSha256 ||
    supplement.version !== 1 ||
    supplement.baseCorpusSha256 !== reviewedCorpusSha256 ||
    !Array.isArray(supplement.cases) ||
    supplement.cases.length !== 40 ||
    !Array.isArray(supplement.heldCases) ||
    supplement.heldCases.length !== 4 ||
    supplement.heldCases.some(
      (row) => row.observations?.org?.type !== "unknown",
    )
  )
    throw new Error("Reviewed candidate-5 TRAIN supplement changed");
  const ids = new Set();
  const groups = new Map();
  for (const row of supplement.cases) {
    if (
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.groupId !== "string" ||
      !row.groupId ||
      row.split !== "train" ||
      !["allow", "confirm"].includes(row.expected) ||
      row.family === "browser" ||
      row.toolName?.startsWith("sf_browser_") ||
      row.observations?.org?.type === "unknown" ||
      !Array.isArray(row.sourceEvidence) ||
      row.sourceEvidence.length === 0
    )
      throw new Error(`Invalid non-browser TRAIN supplement row ${row.id}`);
    ids.add(row.id);
    const labels = groups.get(row.groupId) ?? new Set();
    labels.add(row.expected);
    groups.set(row.groupId, labels);
  }
  if (
    groups.size !== 9 ||
    [...groups.values()].some((labels) => labels.size !== 2)
  )
    throw new Error(
      "TRAIN supplement groups lost their allow/confirm contrasts",
    );
  return groups;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      checkpoint: { type: "string" },
      output: { type: "string" },
      receipt: { type: "string" },
    },
  });
  if (
    Object.keys(values).length !== 5 ||
    Object.values(values).some((value) => !value)
  )
    throw new Error(
      "Required: --sf-pi DIR --sf-deps NODE_MODULES_DIR --checkpoint ORIGINAL_GOOGLE_SNAPSHOT --output NEW_TRAIN_JSONL --receipt NEW_JSON",
    );
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const checkpoint = resolve(values.checkpoint);
  const output = resolve(values.output);
  const receipt = resolve(values.receipt);
  if (
    output === receipt ||
    inDirectory(output, officialRun) ||
    inDirectory(receipt, officialRun)
  )
    throw new Error(
      "Research outputs must be distinct and outside the official candidate-5 run",
    );
  if (!(await stat(sfDeps)).isDirectory())
    throw new Error("--sf-deps must be an installed node_modules directory");
  if (
    !checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${RFDT_BASE_REVISION}`,
    ) ||
    (await hashFile(resolve(checkpoint, "model.safetensors"))) !==
      originalWeightsSha256 ||
    !(await stat(resolve(checkpoint, "config.json"))).isFile() ||
    !(await stat(resolve(checkpoint, "tokenizer.json"))).isFile()
  )
    throw new Error("Use the verified original Google Gemma 3 1B checkpoint");

  const [
    supplementBytes,
    treeBytes,
    policyBytes,
    scorerBytes,
    scriptBytes,
    sfLockBytes,
  ] = await Promise.all([
    readFile(supplementPath),
    readFile(treePath),
    readFile(policyPath),
    readFile(resolve(root, "dist/guardrail.js")),
    readFile(fileURLToPath(import.meta.url)),
    readFile(resolve(sf, "package-lock.json")),
  ]);
  const supplement = JSON.parse(supplementBytes);
  const groups = validateSupplement(supplement, sha(supplementBytes));
  const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sf,
    encoding: "utf8",
  }).trim();
  // Resolve missing SF dependencies from an explicitly supplied installed tree
  // without adding node_modules or any other file to the SF worktree.
  const sfDependenciesParent = pathToFileURL(
    resolve(sfDeps, "__c5_resolver__.mjs"),
  ).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          error.code !== "ERR_MODULE_NOT_FOUND" ||
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("node:")
        )
          throw error;
        return nextResolve(specifier, {
          ...context,
          parentURL: sfDependenciesParent,
        });
      }
    },
  });
  const temporaryAgentDir = await mkdtemp(resolve(tmpdir(), "c5-smoke-facts-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;
  try {
    // Use the same mocked host-fact seam as the candidate-5 bundle builder.
    const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput },
      { restoreFromSessionEntries, clearSharedSfEnvironment },
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
    const labelCounts = { allow: 0, confirm: 0 };
    const familyCounts = {};
    const riskInputs = new Set();
    for (const authored of supplement.cases) {
      const row = structuredClone(authored);
      if (typeof row.input?.command === "string")
        row.input.command = row.input.command.replaceAll(
          "__C5_TREE_FIXTURE__",
          treePath,
        );
      const org = row.observations?.org;
      const cwd = "/example/project";
      clearSharedSfEnvironment(cwd);
      if (org) {
        const env = {
          cli: { installed: true, version: "2.0.0" },
          project: { detected: true },
          config: {
            hasTargetOrg: true,
            targetOrg: org.alias,
            location: "Global",
          },
          org: {
            detected: org.type !== "unknown",
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
        sessionId: `c5-smoke-${row.id}`,
        config: readBundledConfig(),
      };
      const baseline = await evaluateSafety(input);
      if (!jevRiskEligible(input) || jevRiskPolicyFloor(input, baseline))
        throw new Error(`TRAIN row is ineligible or exact-floored: ${row.id}`);
      const riskInput = await prepareJevRiskInput(input, baseline);
      if (
        riskInput.version !== 2 ||
        riskInput.toolName !== row.toolName ||
        JSON.stringify(riskInput.input) !== JSON.stringify(row.input) ||
        (org &&
          !riskInput.facts.orgs?.some(
            (fact) => fact.type === org.type && fact.guessed === false,
          ))
      )
        throw new Error(`Current SF host changed TRAIN risk input: ${row.id}`);
      const key = sha(JSON.stringify(riskInput));
      if (riskInputs.has(key))
        throw new Error(`Duplicate TRAIN risk input: ${row.id}`);
      riskInputs.add(key);
      const request = guardrailRequest(riskInput, RFDT_BASE_MODEL);
      examples.push({
        id: row.id,
        group_id: row.groupId,
        split: "train",
        request,
        targets: { risk: { answer: row.expected } },
        target_provenance: { risk: { source: "supplied" } },
      });
      labelCounts[row.expected]++;
      familyCounts[row.family] = (familyCounts[row.family] ?? 0) + 1;
    }
    if (
      examples.length !== 40 ||
      labelCounts.allow === 0 ||
      labelCounts.confirm === 0 ||
      examples.some((row) => row.split !== "train") ||
      calculateJevRiskBaselineIdentity().sha256 !== hostSourceSha256 ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sf,
        encoding: "utf8",
      }).trim() !== sfCommit ||
      (await hashFile(supplementPath)) !== reviewedSupplementSha256
    )
      throw new Error(
        "TRAIN input or SF host changed during smoke preparation",
      );
    const datasetBytes =
      examples.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const receiptValue = {
      version: 1,
      purpose: "nonqualifying_train_only_rfdt_systems_smoke",
      qualification: false,
      officialCandidate5Admission: false,
      reservedSplitScreenedInThisRun: false,
      mockedHostFacts: true,
      modelCalls: 0,
      externalOperationsExecuted: 0,
      trainRows: examples.length,
      trainGroups: groups.size,
      validationRows: 0,
      testRows: 0,
      browserRows: 0,
      heldUnknownOrgRowsExcluded: supplement.heldCases.length,
      labels: labelCounts,
      families: familyCounts,
      plannedOptimizerSteps: 8,
      dataset: { file: output, sha256: sha(datasetBytes) },
      source: {
        supplementFile: supplementPath,
        supplementSha256: reviewedSupplementSha256,
        supplementBaseCorpusSha256: reviewedCorpusSha256,
        authoredSfPiCommit: supplement.sfPiCommit,
        projectedSfPiCommit: sfCommit,
        projectedSfPiRuntimeSha256: hostSourceSha256,
        sfPackageLockSha256: sha(sfLockBytes),
        sfDependenciesDirectory: sfDeps,
        treeFixtureSha256: sha(treeBytes),
        policyInterpretationSha256: sha(policyBytes),
        scorerDistributionSha256: sha(scorerBytes),
        scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        preparationScriptSha256: sha(scriptBytes),
        baseModel: RFDT_BASE_MODEL,
        baseRevision: RFDT_BASE_REVISION,
        baseWeightsSha256: originalWeightsSha256,
        checkpoint,
      },
    };
    await mkdir(dirname(output), { recursive: true });
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(output, datasetBytes, { mode: 0o600, flag: "wx" });
    try {
      await writeFile(receipt, JSON.stringify(receiptValue, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await rm(output);
      throw error;
    }
    console.log(
      JSON.stringify({
        purpose: receiptValue.purpose,
        trainRows: receiptValue.trainRows,
        trainGroups: receiptValue.trainGroups,
        validationRows: 0,
        testRows: 0,
        qualification: false,
        datasetSha256: receiptValue.dataset.sha256,
      }),
    );
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(temporaryAgentDir, { recursive: true, force: true });
  }
}

await main();
