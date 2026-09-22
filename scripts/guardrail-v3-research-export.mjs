#!/usr/bin/env node
/** Research-only TRAIN/VALID replay. The strict candidate-5 exporter stays authoritative. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const officialRun = resolve(root, ".build/guardrail/candidate-5");
const sealedCorpusSha256 =
  "bb4ed147933c076111b127e6a5433c6ce7ea54cc43befb7d384ddb54681e6309";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (file, directory) => {
  const rel = relative(directory, file);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/** Touch only the split field until TEST rows have been dropped. */
export function selectResearchCases(corpus) {
  if (
    corpus.version !== 1 ||
    corpus.rubricVersion !== "operation-policy-v2" ||
    !Array.isArray(corpus.cases)
  )
    throw new Error("Unexpected sealed v3 corpus shape");
  const selected = corpus.cases.filter(
    (row) => row.split === "train" || row.split === "validation",
  );
  if (selected.length !== 504)
    throw new Error("Sealed v3 TRAIN/VALID count changed");
  const ids = new Set();
  const groups = new Map();
  for (const row of selected) {
    if (
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.groupId !== "string" ||
      !row.groupId ||
      !["allow", "confirm", "block"].includes(row.expected) ||
      typeof row.toolName !== "string" ||
      !row.input ||
      typeof row.input !== "object"
    )
      throw new Error(`Invalid selected corpus row ${row.id}`);
    ids.add(row.id);
    const previous = groups.get(row.groupId);
    if (previous && previous !== row.split)
      throw new Error(`Operation group crosses TRAIN/VALID: ${row.groupId}`);
    groups.set(row.groupId, row.split);
  }
  return { selected, groups };
}

function configureHostResolver(sf, sfDeps) {
  const detectUrl = pathToFileURL(
    resolve(sf, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stubUrl = pathToFileURL(
    resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
  ).href;
  const dependenciesParent = pathToFileURL(
    resolve(sfDeps, "__c5_research_resolver__.mjs"),
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

function fixtureConfig(row, readBundledConfig) {
  const config = readBundledConfig();
  for (const [id, behavior] of Object.entries(row.policyBehaviors ?? {})) {
    const rule = [
      ...config.policies.rules,
      ...config.commandGate.patterns,
      ...config.commandGate.autoDenyPatterns,
      ...config.orgAwareGate.rules,
    ].find((candidate) => candidate.id === id);
    if (!rule) throw new Error(`Unknown authored policy override ${id}`);
    rule.behavior = behavior;
  }
  return config;
}

function mockedEnvironment(row) {
  const org = row.observations?.org;
  if (!org) return undefined;
  return {
    cli: { installed: true, version: "2.0.0" },
    project: { detected: true },
    config: { hasTargetOrg: true, targetOrg: org.alias, location: "Global" },
    org: {
      detected: org.type !== "unknown",
      alias: org.alias,
      username: `${org.alias.toLowerCase()}@example.test`,
      orgType: org.type,
    },
    detectedAt: 0,
  };
}

function knownFallback(error) {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  if (
    message ===
    "Jev Salesforce org identity unverified; using Safety Kernel fallback"
  )
    return message;
  if (
    /^Incomplete Jev risk input(?::|$)/.test(message) ||
    /^Jev risk input exceeds (?:structural limits|byte limit(?: after host facts)?)$/.test(
      message,
    ) ||
    message === "Invalid Unicode in Jev risk input" ||
    message ===
      "Incomplete Jev browser facts: fresh reference lacks observed label or role"
  )
    return message.slice(0, 512);
  return undefined;
}

function addCount(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string" },
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      bundle: { type: "string" },
      rfdt: { type: "string" },
      receipt: { type: "string" },
    },
  });
  if (
    Object.keys(values).length !== 6 ||
    Object.values(values).some((value) => !value)
  )
    throw new Error(
      "Required: --corpus SEALED_V3 --sf-pi DIR --sf-deps NODE_MODULES_DIR --bundle NEW_JSON --rfdt NEW_JSONL --receipt NEW_JSON",
    );
  const corpusPath = resolve(values.corpus);
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const bundlePath = resolve(values.bundle);
  const rfdtPath = resolve(values.rfdt);
  const receiptPath = resolve(values.receipt);
  if (
    new Set([bundlePath, rfdtPath, receiptPath]).size !== 3 ||
    [bundlePath, rfdtPath, receiptPath].some((path) =>
      inside(path, officialRun),
    )
  )
    throw new Error(
      "Research outputs must be distinct and outside the official candidate-5 run",
    );
  const [corpusBytes, scriptBytes, stubBytes] = await Promise.all([
    readFile(corpusPath),
    readFile(fileURLToPath(import.meta.url)),
    readFile(resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs")),
  ]);
  if (sha(corpusBytes) !== sealedCorpusSha256)
    throw new Error("Sealed v3 corpus SHA-256 changed");
  const { selected, groups } = selectResearchCases(JSON.parse(corpusBytes));
  const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sf,
    encoding: "utf8",
  }).trim();
  configureHostResolver(sf, sfDeps);
  const temporaryAgentDir = await mkdtemp(
    resolve(tmpdir(), "c5-v3-research-facts-"),
  );
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;
  try {
    const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      {
        jevRiskEligible,
        jevRiskPolicyFloor,
        prepareJevRiskInput,
        JEV_BROWSER_CLICK_FALLBACK_REASON,
        JEV_BROWSER_PRESS_FALLBACK_REASON,
      },
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
    const records = [];
    const examples = [];
    const bySplit = {
      train: { total: 0, eligible: 0 },
      validation: { total: 0, eligible: 0 },
    };
    const eligibleFamily = { train: {}, validation: {} };
    const fallbackReasons = {};
    for (const row of selected) {
      const cwd = "/example/project";
      clearSharedSfEnvironment(cwd);
      const env = mockedEnvironment(row);
      if (env)
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
      const input = {
        toolName: row.toolName,
        input: row.input,
        cwd,
        sessionId: `c5-v3-research-${row.id}`,
        config: fixtureConfig(row, readBundledConfig),
      };
      let baseline = null;
      let policyFloor = null;
      let modelEligible = false;
      let fallbackReason;
      let riskInput = null;
      if (row.toolName === "sf_browser_click")
        fallbackReason = JEV_BROWSER_CLICK_FALLBACK_REASON;
      else if (row.toolName === "sf_browser_press")
        fallbackReason = JEV_BROWSER_PRESS_FALLBACK_REASON;
      else if (!jevRiskEligible(input))
        fallbackReason = "Tool remains with the existing Safety Kernel";
      else {
        const decision = await evaluateSafety(input);
        baseline = decision?.action ?? "allow";
        policyFloor = jevRiskPolicyFloor(input, decision);
        if (policyFloor)
          fallbackReason =
            "Exact policy floor remains with the existing Safety Kernel";
        else {
          try {
            riskInput = await prepareJevRiskInput(input, decision);
            if (
              riskInput.version !== 2 ||
              riskInput.toolName !== row.toolName ||
              JSON.stringify(riskInput.input) !== JSON.stringify(row.input)
            )
              throw new Error(
                `Current SF host changed authored request ${row.id}`,
              );
            modelEligible = true;
          } catch (error) {
            fallbackReason = knownFallback(error);
            if (!fallbackReason) throw error;
          }
        }
      }
      if (modelEligible && row.expected === "block")
        throw new Error(`Model-eligible block label in ${row.split}/${row.id}`);
      let request;
      if (modelEligible) {
        try {
          request = guardrailRequest(riskInput, RFDT_BASE_MODEL);
        } catch (error) {
          if (error?.message !== "Invalid or incomplete guardrail risk input")
            throw error;
          modelEligible = false;
          riskInput = null;
          fallbackReason = "Current Jev scorer rejected host v2 input";
        }
      }
      if (!modelEligible) addCount(fallbackReasons, fallbackReason);
      bySplit[row.split].total++;
      if (modelEligible) {
        bySplit[row.split].eligible++;
        addCount(eligibleFamily[row.split], `${row.family}:${row.expected}`);
        examples.push({
          id: row.id,
          group_id: row.groupId,
          split: row.split,
          request,
          targets: { risk: { answer: row.expected } },
          target_provenance: { risk: { source: "supplied" } },
        });
      }
      records.push({
        id: row.id,
        groupId: row.groupId,
        family: row.family,
        split: row.split,
        expected: row.expected,
        goldSource: "authored_operation_policy_v2",
        baseline,
        policyFloor,
        modelEligible,
        riskInput,
        ...(fallbackReason ? { fallbackReason } : {}),
      });
    }
    if (
      records.length !== 504 ||
      bySplit.train.total !== 312 ||
      bySplit.validation.total !== 192 ||
      records.some((row) => row.split === "test") ||
      examples.some((row) => row.split === "test") ||
      calculateJevRiskBaselineIdentity().sha256 !== hostSourceSha256 ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sf,
        encoding: "utf8",
      }).trim() !== sfCommit ||
      sha(await readFile(corpusPath)) !== sealedCorpusSha256
    )
      throw new Error(
        "Research source changed or held-out split entered export",
      );
    const source = {
      sealedCorpusFile: corpusPath,
      sealedCorpusSha256,
      sfPiCommit: sfCommit,
      sfPiRuntimeSha256: hostSourceSha256,
      scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      researchScriptSha256: sha(scriptBytes),
      mockDetectorSha256: sha(stubBytes),
      baseModel: RFDT_BASE_MODEL,
      baseRevision: RFDT_BASE_REVISION,
    };
    const bundle = {
      version: 1,
      purpose: "nonqualifying_v3_train_validation_research_export",
      diagnosticOnly: true,
      trainingReady: false,
      qualification: false,
      mockedHostFacts: true,
      browserModelEligible: false,
      browserBaselineMeasured: false,
      nonModelToolBaselineMeasured: false,
      filesystemExistenceMocked: false,
      source,
      records,
    };
    const bundleBytes = JSON.stringify(bundle, null, 2) + "\n";
    const rfdtBytes =
      examples.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const receipt = {
      version: 1,
      purpose: bundle.purpose,
      qualification: false,
      officialCandidate5Admission: false,
      heldOutContentEmitted: false,
      modelCalls: 0,
      externalOperationsExecuted: 0,
      browserBaselineMeasured: false,
      nonModelToolBaselineMeasured: false,
      filesystemExistenceMocked: false,
      totalRows: records.length,
      totalGroups: groups.size,
      bySplit,
      eligibleFamily,
      fallbackReasons,
      bundle: { file: bundlePath, sha256: sha(bundleBytes) },
      rfdt: { file: rfdtPath, rows: examples.length, sha256: sha(rfdtBytes) },
      source,
    };
    const written = [];
    try {
      for (const [path, bytes] of [
        [bundlePath, bundleBytes],
        [rfdtPath, rfdtBytes],
        [receiptPath, JSON.stringify(receipt, null, 2) + "\n"],
      ]) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        written.push(path);
      }
    } catch (error) {
      await Promise.all(written.map((path) => rm(path)));
      throw error;
    }
    console.log(
      JSON.stringify({
        purpose: receipt.purpose,
        bySplit,
        browserFallbacks:
          (fallbackReasons[JEV_BROWSER_CLICK_FALLBACK_REASON] ?? 0) +
          (fallbackReasons[JEV_BROWSER_PRESS_FALLBACK_REASON] ?? 0),
        rfdtRows: examples.length,
        qualification: false,
        bundleSha256: receipt.bundle.sha256,
        rfdtSha256: receipt.rfdt.sha256,
      }),
    );
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(temporaryAgentDir, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  await main();
