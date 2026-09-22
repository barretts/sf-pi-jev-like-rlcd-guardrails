#!/usr/bin/env node
/** Project only the separate C6 TRAIN proposals through the committed, model-free host. */
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
const outputRoot = resolve(root, ".build/guardrail");
const augmentationPath = resolve(
  root,
  "fixtures/guardrail/candidate6/train-augmentation.json",
);
const browserPath = resolve(
  root,
  "fixtures/guardrail/candidate6/browser-train-proposal.json",
);
const scorerPath = resolve(root, "dist/guardrail.js");
const stubPath = resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs");
const scriptPath = fileURLToPath(import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function validateProposal(value, name, count, prefix) {
  if (
    value?.version !== 1 ||
    value.rubric !== "operation-policy-v2" ||
    !String(value.status).includes("TRAIN-only") ||
    value.trainingReady !== false ||
    value.qualification !== false ||
    value.humanLabelReviewed !== false ||
    !Array.isArray(value.cases) ||
    value.cases.length !== count
  )
    throw new Error(`Unexpected ${name} TRAIN proposal`);
  const ids = new Set();
  const groups = new Map();
  for (const row of value.cases) {
    if (
      typeof row.id !== "string" ||
      !row.id.startsWith(prefix) ||
      ids.has(row.id) ||
      typeof row.groupId !== "string" ||
      !row.groupId.startsWith(prefix) ||
      row.split !== "train" ||
      !["allow", "confirm"].includes(row.expected) ||
      typeof row.toolName !== "string" ||
      !row.toolName ||
      !row.input ||
      typeof row.input !== "object" ||
      Array.isArray(row.input) ||
      !row.observations ||
      typeof row.observations !== "object" ||
      Array.isArray(row.observations) ||
      !Array.isArray(row.fixturePreconditions) ||
      row.fixturePreconditions.length === 0 ||
      !Array.isArray(row.sourceEvidence) ||
      !row.sourceEvidence.includes("fixtures/guardrail/RUBRIC.md")
    )
      throw new Error(`Invalid ${name} TRAIN row ${row?.id}`);
    ids.add(row.id);
    const labels = groups.get(row.groupId) ?? new Set();
    labels.add(row.expected);
    groups.set(row.groupId, labels);
  }
  if (
    groups.size !== count / 2 ||
    [...groups.values()].some(
      (labels) =>
        labels.size !== 2 || !labels.has("allow") || !labels.has("confirm"),
    )
  )
    throw new Error(`${name} TRAIN operation groups lost their matched labels`);
  return { ids, groups };
}

function configureHostResolver(sf, sfDeps) {
  const detectUrl = pathToFileURL(
    resolve(sf, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stubUrl = pathToFileURL(stubPath).href;
  const dependencyParent = pathToFileURL(
    resolve(sfDeps, "__c6_proposal_resolver__.mjs"),
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
}

function restoreMockOrg(
  row,
  cwd,
  clearSharedSfEnvironment,
  restoreFromSessionEntries,
) {
  clearSharedSfEnvironment(cwd);
  const org = row.observations.org;
  if (!org) return;
  if (
    typeof org.alias !== "string" ||
    !org.alias ||
    !["production", "sandbox", "scratch", "developer"].includes(org.type)
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

function restoreMockBrowser(row, sessionId, writeLatestBrowserSnapshotRefs) {
  const ref = row.observations.browserRef;
  const page = row.observations.browserPage;
  if (
    row.toolName !== "sf_browser_click" ||
    ref?.status !== "fresh" ||
    page?.status !== "fresh" ||
    ref.ref !== row.input.ref ||
    !ref.label ||
    !ref.role ||
    typeof page.snapshot !== "string" ||
    !page.snapshot.includes(ref.line) ||
    sha(page.snapshot) !== page.snapshotSha256 ||
    !/^https?:\/\//.test(page.url)
  )
    throw new Error(
      `Incomplete independently authored browser snapshot: ${row.id}`,
    );
  const captured = writeLatestBrowserSnapshotRefs({
    sessionId,
    snapshot: page.snapshot,
    url: page.url,
  });
  const entry = captured.refs.find(
    (candidate) => candidate.ref === row.input.ref,
  );
  if (
    captured.snapshotSha256 !== page.snapshotSha256 ||
    captured.url !== page.url ||
    !entry ||
    entry.line !== ref.line ||
    entry.role !== ref.role ||
    entry.label !== ref.label
  )
    throw new Error(`Browser ref and page capture disagree: ${row.id}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      "sf-commit": { type: "string" },
      "sf-runtime-sha256": { type: "string" },
      "augmentation-sha256": { type: "string" },
      "browser-sha256": { type: "string" },
      "scorer-protocol-sha256": { type: "string" },
      "scorer-distribution-sha256": { type: "string" },
      "output-dir": { type: "string" },
    },
    strict: true,
  });
  for (const key of [
    "sf-pi",
    "sf-deps",
    "sf-commit",
    "sf-runtime-sha256",
    "augmentation-sha256",
    "browser-sha256",
    "scorer-protocol-sha256",
    "scorer-distribution-sha256",
    "output-dir",
  ])
    if (!values[key]) throw new Error(`Missing --${key}`);
  if (!/^[a-f0-9]{40}$/.test(values["sf-commit"]))
    throw new Error("Invalid --sf-commit");
  for (const key of [
    "sf-runtime-sha256",
    "augmentation-sha256",
    "browser-sha256",
    "scorer-protocol-sha256",
    "scorer-distribution-sha256",
  ])
    if (!/^[a-f0-9]{64}$/.test(values[key]))
      throw new Error(`Invalid --${key}`);
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const outputDir = resolve(values["output-dir"]);
  const outputRel = relative(outputRoot, outputDir);
  if (
    !outputRel ||
    outputRel === ".." ||
    outputRel.startsWith(`..${sep}`) ||
    isAbsolute(outputRel) ||
    !basename(outputDir).startsWith("candidate-6-proposal-projection-")
  )
    throw new Error(
      "Output must be a fresh candidate-6-proposal-projection-* build directory",
    );
  if (
    !(await stat(sfDeps)).isDirectory() ||
    !(await stat(resolve(sfDeps, ".package-lock.json"))).isFile()
  )
    throw new Error("--sf-deps must be installed node_modules with a lockfile");
  if (
    git(sf, "rev-parse", "HEAD") !== values["sf-commit"] ||
    git(sf, "status", "--porcelain")
  )
    throw new Error("sf-pi is not the requested clean committed host");

  const [
    augmentationBytes,
    browserBytes,
    scorerBytes,
    scriptBytes,
    stubBytes,
    sfLockBytes,
    sfDepsLockBytes,
  ] = await Promise.all([
    readFile(augmentationPath),
    readFile(browserPath),
    readFile(scorerPath),
    readFile(scriptPath),
    readFile(stubPath),
    readFile(resolve(sf, "package-lock.json")),
    readFile(resolve(sfDeps, ".package-lock.json")),
  ]);
  if (
    sha(augmentationBytes) !== values["augmentation-sha256"] ||
    sha(browserBytes) !== values["browser-sha256"] ||
    sha(scorerBytes) !== values["scorer-distribution-sha256"] ||
    GUARDRAIL_PROTOCOL_SHA256 !== values["scorer-protocol-sha256"]
  )
    throw new Error("Pinned proposal or Jev scorer source changed");
  const augmentation = JSON.parse(augmentationBytes);
  const browser = JSON.parse(browserBytes);
  const augCounts = validateProposal(
    augmentation,
    "augmentation",
    6,
    "c6-aug-",
  );
  const browserCounts = validateProposal(
    browser,
    "browser",
    4,
    "c6-browser-train-",
  );
  if (
    augmentation.sfPiSourceCommit !== values["sf-commit"] ||
    [...browserCounts.ids].some((id) => augCounts.ids.has(id)) ||
    [...browserCounts.groups.keys()].some((id) => augCounts.groups.has(id))
  )
    throw new Error("TRAIN proposal source host or identities disagree");

  configureHostResolver(sf, sfDeps);
  const agentDir = await mkdtemp(resolve(tmpdir(), "c6-proposal-facts-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      {
        jevBrowserClickEvidenceFingerprint,
        jevRiskEligible,
        jevRiskPolicyFloor,
        prepareJevRiskInput,
      },
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
    const hostRuntime = calculateJevRiskBaselineIdentity().sha256;
    if (hostRuntime !== values["sf-runtime-sha256"])
      throw new Error("sf-pi runtime differs from requested source pin");
    const rows = [...augmentation.cases, ...browser.cases];
    const examples = [];
    const modelInputs = new Set();
    const baselineActions = { allow: 0, confirm: 0, block: 0 };
    const families = {};
    for (const row of rows) {
      const cwd = "/example/project";
      const sessionId = `c6-proposal-${row.id}`;
      restoreMockOrg(
        row,
        cwd,
        clearSharedSfEnvironment,
        restoreFromSessionEntries,
      );
      if (row.family === "browser")
        restoreMockBrowser(row, sessionId, writeLatestBrowserSnapshotRefs);
      const input = {
        toolName: row.toolName,
        input: row.input,
        cwd,
        sessionId,
        config: readBundledConfig(),
      };
      const browserBefore =
        row.family === "browser"
          ? jevBrowserClickEvidenceFingerprint(input)
          : null;
      if (row.family === "browser" && !browserBefore)
        throw new Error(`No fresh browser evidence before baseline: ${row.id}`);
      const baseline = await evaluateSafety(input);
      const action = baseline?.action ?? "allow";
      if (!Object.hasOwn(baselineActions, action))
        throw new Error(`Invalid Safety Kernel action: ${row.id}`);
      baselineActions[action]++;
      if (!jevRiskEligible(input) || jevRiskPolicyFloor(input, baseline))
        throw new Error(`TRAIN row is ineligible or exact-floored: ${row.id}`);
      if (row.family === "browser" && action !== "allow")
        throw new Error(
          `Browser model can only tighten baseline allow: ${row.id}`,
        );
      const riskInput = await prepareJevRiskInput(input, baseline);
      if (
        riskInput.version !== 2 ||
        riskInput.toolName !== row.toolName ||
        JSON.stringify(riskInput.input) !== JSON.stringify(row.input)
      )
        throw new Error(`Host changed the original tool request: ${row.id}`);
      if (
        row.observations.org &&
        !riskInput.facts.orgs?.some(
          (fact) =>
            fact.type === row.observations.org.type && fact.guessed === false,
        )
      )
        throw new Error(`Independent org fact mismatch: ${row.id}`);
      if (row.family === "browser") {
        const ref = row.observations.browserRef;
        const page = row.observations.browserPage;
        if (
          riskInput.facts.browserRef?.status !== "fresh" ||
          riskInput.facts.browserRef.role !== ref.role ||
          riskInput.facts.browserRef.label !== ref.label ||
          riskInput.facts.browserRef.snapshotSha256 !== page.snapshotSha256 ||
          riskInput.facts.browserPage?.status !== "fresh" ||
          riskInput.facts.browserPage.url !== page.url ||
          riskInput.facts.browserPage.snapshotSha256 !== page.snapshotSha256 ||
          jevBrowserClickEvidenceFingerprint(input) !== browserBefore
        )
          throw new Error(`Independent browser fact mismatch: ${row.id}`);
      }
      const inputHash = sha(JSON.stringify(riskInput));
      if (modelInputs.has(inputHash))
        throw new Error(`Duplicate TRAIN model input: ${row.id}`);
      modelInputs.add(inputHash);
      examples.push({
        id: row.id,
        group_id: row.groupId,
        split: "train",
        request: guardrailRequest(riskInput, RFDT_BASE_MODEL),
        targets: { risk: { answer: row.expected } },
        target_provenance: { risk: { source: "supplied" } },
      });
      families[row.family] = (families[row.family] ?? 0) + 1;
    }
    if (
      examples.length !== 10 ||
      modelInputs.size !== 10 ||
      git(sf, "rev-parse", "HEAD") !== values["sf-commit"] ||
      git(sf, "status", "--porcelain") ||
      calculateJevRiskBaselineIdentity().sha256 !== hostRuntime ||
      sha(await readFile(augmentationPath)) !== values["augmentation-sha256"] ||
      sha(await readFile(browserPath)) !== values["browser-sha256"] ||
      sha(await readFile(scorerPath)) !==
        values["scorer-distribution-sha256"] ||
      sha(await readFile(scriptPath)) !== sha(scriptBytes)
    )
      throw new Error(
        "C6 proposal, scorer, or committed host changed during projection",
      );
    const datasetBytes = `${examples.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const datasetPath = resolve(outputDir, "train.jsonl");
    const receiptPath = resolve(outputDir, "receipt.json");
    const receipt = {
      version: 1,
      purpose: "candidate6_proposal_train_only_model_free_projection",
      qualification: false,
      trainingReady: false,
      humanLabelReviewed: false,
      blindSplitScreened: false,
      modelCalls: 0,
      externalOperationsExecuted: 0,
      browserInputsDispatched: 0,
      mockedHostFacts: true,
      trainRows: examples.length,
      trainGroups: augCounts.groups.size + browserCounts.groups.size,
      validationRows: 0,
      testRows: 0,
      labels: {
        allow: examples.filter((row) => row.targets.risk.answer === "allow")
          .length,
        confirm: examples.filter((row) => row.targets.risk.answer === "confirm")
          .length,
      },
      families,
      baselineActions,
      dataset: { file: datasetPath, sha256: sha(datasetBytes) },
      source: {
        augmentationSha256: values["augmentation-sha256"],
        browserProposalSha256: values["browser-sha256"],
        sfPiCommit: values["sf-commit"],
        sfPiRuntimeSha256: hostRuntime,
        sfPackageLockSha256: sha(sfLockBytes),
        sfDependenciesDirectory: sfDeps,
        sfDependenciesLockSha256: sha(sfDepsLockBytes),
        mockDiscoveryStubSha256: sha(stubBytes),
        scorerDistributionSha256: values["scorer-distribution-sha256"],
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
        labels: receipt.labels,
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
