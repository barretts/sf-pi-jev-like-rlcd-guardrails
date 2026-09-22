#!/usr/bin/env node
/** Replay a pinned C6 TRAIN click proposal through a committed host with no model or click. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const fixture = resolve(
  root,
  "fixtures/guardrail/candidate6/browser-train-proposal.json",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitHead = (directory) =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    "sf-commit": { type: "string" },
    "sf-runtime-sha256": { type: "string" },
    "proposal-sha256": { type: "string" },
    "output-dir": { type: "string" },
  },
});
for (const required of [
  "sf-pi",
  "sf-deps",
  "sf-commit",
  "sf-runtime-sha256",
  "proposal-sha256",
  "output-dir",
])
  if (!values[required]) throw new Error(`Missing --${required}`);

const sf = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const outputDir = resolve(values["output-dir"]);
const outputRelative = relative(buildRoot, outputDir);
if (
  !outputRelative ||
  outputRelative === ".." ||
  outputRelative.startsWith(`..${sep}`) ||
  isAbsolute(outputRelative) ||
  !basename(outputDir).startsWith("candidate-6-browser-preflight-")
)
  throw new Error(
    "Output must be a fresh candidate-6-browser-preflight-* build directory",
  );
for (const key of ["sf-runtime-sha256", "proposal-sha256"])
  if (!/^[a-f0-9]{64}$/.test(values[key])) throw new Error(`Invalid --${key}`);
if (gitHead(sf) !== values["sf-commit"])
  throw new Error("sf-pi commit differs from requested source pin");
const proposalBytes = await readFile(fixture);
if (sha(proposalBytes) !== values["proposal-sha256"])
  throw new Error("Browser TRAIN proposal differs from source pin");
const proposal = JSON.parse(proposalBytes);
if (
  proposal.version !== 1 ||
  proposal.rubric !== "operation-policy-v2" ||
  proposal.trainingReady !== false ||
  proposal.qualification !== false ||
  !Array.isArray(proposal.cases) ||
  proposal.cases.length !== 4 ||
  proposal.cases.some(
    (row) => row.split !== "train" || row.toolName !== "sf_browser_click",
  )
)
  throw new Error("Unexpected browser TRAIN proposal");

const detect = pathToFileURL(
  resolve(sf, "lib/common/sf-environment/detect.ts"),
).href;
const stub = pathToFileURL(
  resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
).href;
const dependencyParent = pathToFileURL(
  resolve(sfDeps, "__c6_browser_resolver__.mjs"),
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

const agentDir = await mkdtemp(resolve(tmpdir(), "c6-browser-facts-"));
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
    { writeLatestBrowserSnapshotRefs },
    { calculateJevRiskBaselineIdentity },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("lib/common/sf-browser-snapshot-state.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
  ]);
  const runtimeSha = calculateJevRiskBaselineIdentity().sha256;
  if (runtimeSha !== values["sf-runtime-sha256"])
    throw new Error("sf-pi runtime differs from requested source pin");
  const ids = new Set();
  const groups = new Map();
  const hashes = new Set();
  const baselineActions = { allow: 0, confirm: 0, block: 0 };
  for (const row of proposal.cases) {
    if (ids.has(row.id)) throw new Error("Duplicate browser TRAIN id");
    ids.add(row.id);
    const labels = groups.get(row.groupId) ?? new Set();
    labels.add(row.expected);
    groups.set(row.groupId, labels);
    const page = row.observations?.browserPage;
    const ref = row.observations?.browserRef;
    if (
      page?.status !== "fresh" ||
      ref?.status !== "fresh" ||
      !page.snapshot ||
      !page.url
    )
      throw new Error(`Missing independent browser snapshot: ${row.id}`);
    if (
      sha(page.snapshot) !== page.snapshotSha256 ||
      !page.snapshot.includes(ref.line)
    )
      throw new Error(`Browser snapshot source mismatch: ${row.id}`);
    const sessionId = `c6-browser-preflight-${row.id}`;
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
      !entry ||
      entry.line !== ref.line ||
      entry.role !== ref.role ||
      entry.label !== ref.label
    )
      throw new Error(`Browser ref and page capture disagree: ${row.id}`);
    const input = {
      toolName: row.toolName,
      input: row.input,
      cwd: "/example/project",
      sessionId,
      config: readBundledConfig(),
    };
    const evidenceBefore = jevBrowserClickEvidenceFingerprint(input);
    if (!evidenceBefore) throw new Error(`No fresh click evidence: ${row.id}`);
    const baseline = await evaluateSafety(input);
    baselineActions[baseline?.action ?? "allow"]++;
    if (baseline?.action && baseline.action !== "allow")
      throw new Error(`Browser baseline is not allow: ${row.id}`);
    if (!jevRiskEligible(input) || jevRiskPolicyFloor(input, baseline))
      throw new Error(`Browser row ineligible or exact-floored: ${row.id}`);
    const riskInput = await prepareJevRiskInput(input, baseline);
    if (
      riskInput.toolName !== row.toolName ||
      JSON.stringify(riskInput.input) !== JSON.stringify(row.input) ||
      riskInput.facts.browserRef?.status !== "fresh" ||
      riskInput.facts.browserRef.label !== ref.label ||
      riskInput.facts.browserRef.role !== ref.role ||
      riskInput.facts.browserPage?.url !== page.url ||
      riskInput.facts.browserPage.snapshotSha256 !== page.snapshotSha256 ||
      jevBrowserClickEvidenceFingerprint(input) !== evidenceBefore
    )
      throw new Error(`Browser model input or evidence changed: ${row.id}`);
    guardrailRequest(riskInput, RFDT_BASE_MODEL);
    const riskHash = sha(JSON.stringify(riskInput));
    if (hashes.has(riskHash)) throw new Error("Duplicate browser model input");
    hashes.add(riskHash);
  }
  if (
    groups.size !== 2 ||
    [...groups.values()].some((labels) => labels.size !== 2) ||
    sha(await readFile(fixture)) !== values["proposal-sha256"] ||
    calculateJevRiskBaselineIdentity().sha256 !== runtimeSha ||
    gitHead(sf) !== values["sf-commit"]
  )
    throw new Error("Browser TRAIN source or host changed during preflight");
  const receipt = {
    version: 1,
    purpose: "candidate6_browser_train_only_model_free_host_preflight",
    qualification: false,
    trainingReady: false,
    humanLabelReviewed: false,
    modelCalls: 0,
    browserInputsDispatched: 0,
    rows: proposal.cases.length,
    groups: groups.size,
    baselineActions,
    source: {
      proposalSha256: values["proposal-sha256"],
      sfPiCommit: values["sf-commit"],
      sfPiRuntimeSha256: runtimeSha,
      scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      scorerDistributionSha256: sha(
        await readFile(resolve(root, "dist/guardrail.js")),
      ),
      preflightScriptSha256: sha(
        await readFile(fileURLToPath(import.meta.url)),
      ),
    },
  };
  await mkdir(buildRoot, { recursive: true });
  await mkdir(outputDir, { recursive: false });
  try {
    await writeFile(
      resolve(outputDir, "receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  console.log(
    JSON.stringify({
      rows: receipt.rows,
      groups: receipt.groups,
      baselineActions,
      trainingReady: false,
      receipt: resolve(outputDir, "receipt.json"),
    }),
  );
} finally {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  await rm(agentDir, { recursive: true, force: true });
}
