#!/usr/bin/env node
/** Model-free replay of the corrected C6 TRAIN/VALID development pool. Never opens TEST. */
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
import {
  applyCandidate6Corrections,
  CORRECTIONS,
  WITHHELD_TRAIN_GROUPS,
} from "./guardrail-candidate6-corrections.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, ".build/guardrail");
const sourceSha256 =
  "f97050f508c45c16bf14b8c68aae50cf51e43404056bffe25cb91dd1365983ea";
const correctedSha256 =
  "5305ae1e746d26dc840d33d0da3c6015a16b2061fbe48a18d734617e6c79bee1";
const correctionScriptSha256 =
  "078049c99756bc3e8193c6095efb563c221e32f82c110d0345fa9e7f38362309";
const protocolSha256 =
  "b249564d783087cd105fec3c1f92c4ce93201c1ae06958e8498b35aa2988cd8e";
const sfCommit = "e456e1c9c7c0c9b97ccb08f4084558e5cbcd7a8c";
const sfRuntimeSha256 =
  "b1dd0309a789b30c98a7d14a01d843fc3ab199d1542d023ce97c10cbcd2a9e7d";
const discoveryStubSha256 =
  "6f2de20efc26434e87510be0e9e7dd40e035a0ae449a43ce12c1d17acab68dce";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const inside = (file, directory) => {
  const rel = relative(directory, file);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
};
const gitHead = (directory) =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();

function parseJsonlWithoutTest(bytes) {
  const rows = [];
  for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
    const row = JSON.parse(line);
    // Read the split before any request, label, or fixture content.
    if (row?.split !== "train" && row?.split !== "validation")
      throw new Error("Corrected host replay refuses TEST or unknown split");
    rows.push(row);
  }
  return rows;
}

/** Verify both receipts and regenerate every corrected byte from the pinned C5 input. */
export async function verifyCorrectedSource({
  datasetPath,
  receiptPath,
  mergeReceiptPath,
}) {
  const [datasetBytes, receiptBytes, mergeBytes, correctionBytes] =
    await Promise.all([
      readFile(datasetPath),
      readFile(receiptPath),
      readFile(mergeReceiptPath),
      readFile(resolve(root, "scripts/guardrail-candidate6-corrections.mjs")),
    ]);
  const receipt = JSON.parse(receiptBytes);
  const merge = JSON.parse(mergeBytes);
  if (
    GUARDRAIL_PROTOCOL_SHA256 !== protocolSha256 ||
    sha(correctionBytes) !== correctionScriptSha256 ||
    sha(datasetBytes) !== correctedSha256 ||
    receipt?.version !== 1 ||
    receipt.purpose !== "nonqualifying_candidate6_corrected_development_pool" ||
    receipt.qualification !== false ||
    receipt.trainingReady !== false ||
    receipt.heldOutTestUsed !== false ||
    receipt.hostReplayRequired !== true ||
    receipt.humanLabelReviewRequired !== true ||
    receipt.fixtureStatus !== "declared_only_not_executed" ||
    canonical(receipt.split) !==
      canonical({ train: 161, validation: 96, test: 0 }) ||
    receipt.collisionScreen?.disjointProven !== false ||
    canonical(receipt.changedGroups) !==
      canonical(
        CORRECTIONS.map(({ sourceGroup, targetGroup, split, fixture }) => ({
          sourceGroup,
          targetGroup,
          split,
          fixture,
        })),
      ) ||
    canonical(receipt.withheldTrainGroups) !==
      canonical(WITHHELD_TRAIN_GROUPS) ||
    resolve(receipt.output?.file ?? "") !== datasetPath ||
    receipt.output?.sha256 !== correctedSha256 ||
    receipt.source?.inputSha256 !== sourceSha256 ||
    receipt.source?.scriptSha256 !== correctionScriptSha256 ||
    receipt.source?.scoringProtocolSha256 !== protocolSha256 ||
    merge?.version !== 1 ||
    merge.purpose !== "nonqualifying_v3_research_merged_train_validation" ||
    merge.qualification !== false ||
    merge.officialCandidate5Admission !== false ||
    merge.heldOutContentEmitted !== false ||
    canonical(
      merge.rows && {
        train: merge.rows.train,
        validation: merge.rows.validation,
        test: merge.rows.test,
      },
    ) !== canonical({ train: 167, validation: 96, test: 0 }) ||
    merge.source?.sfPiCommit !== sfCommit ||
    merge.source?.sfPiRuntimeSha256 !== sfRuntimeSha256 ||
    merge.source?.scorerProtocolSha256 !== protocolSha256 ||
    merge.source?.model !== RFDT_BASE_MODEL ||
    merge.source?.revision !== RFDT_BASE_REVISION ||
    resolve(merge.dataset?.file ?? "") !==
      resolve(receipt.source?.input ?? "") ||
    merge.dataset?.sha256 !== sourceSha256
  )
    throw new Error(
      "Corrected development source or receipt differs from pinned C5/C6 identity",
    );
  const sourceBytes = await readFile(merge.dataset.file);
  if (sha(sourceBytes) !== sourceSha256)
    throw new Error("Pinned C5 merged TRAIN/VALID bytes changed");
  const regenerated = applyCandidate6Corrections(
    parseJsonlWithoutTest(sourceBytes),
  );
  const regeneratedBytes = Buffer.from(
    regenerated.rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  if (
    !regeneratedBytes.equals(datasetBytes) ||
    canonical(regenerated.collisionScreen) !==
      canonical(receipt.collisionScreen)
  )
    throw new Error(
      "Corrected TRAIN/VALID bytes or collision screen do not regenerate from C5",
    );
  const rows = parseJsonlWithoutTest(datasetBytes);
  if (rows.length !== 257)
    throw new Error("Corrected development row count changed");
  return {
    rows,
    datasetBytes,
    receiptBytes,
    mergeBytes,
    sourceBytes,
    correctionBytes,
    receipt,
  };
}

/** A fixture declaration, independent of the stored risk fact's type and command. */
export function declaredOrgFixture(row) {
  const state = row.request.state;
  const facts = state.facts?.orgs;
  if (facts === undefined) return null;
  if (!Array.isArray(facts) || facts.length !== 1)
    throw new Error(`Unsupported org fact cardinality: ${row.id}`);
  const command = state.input?.command;
  const alias =
    typeof command === "string"
      ? (command.match(
          /(?:^|\s)(?:-o|--target-org)(?:=|\s+)([A-Za-z0-9_-]+)/,
        )?.[1] ?? "DevOrg")
      : state.input?.target_org;
  const standard = {
    DevOrg: "sandbox",
    ProdOrg: "production",
    ScratchOrg: "scratch",
    C5Target902: "production",
    C5TraceProd: "production",
  };
  let type = standard[alias];
  if (alias === "C5Target903" || alias === "NuanceTarget732")
    type = row.id.includes("-safe") ? "sandbox" : "production";
  if (alias === "C5Target905")
    type = row.id.includes("-sandbox-") ? "sandbox" : "production";
  if (!type || typeof alias !== "string")
    throw new Error(`No independent org fixture declaration: ${row.id}`);
  if (
    facts[0]?.type !== type ||
    facts[0]?.guessed !== false ||
    facts[0]?.command !== (command ?? undefined)
  )
    throw new Error(
      `Stored org fact disagrees with declared fixture: ${row.id}`,
    );
  const corrected = CORRECTIONS.find(
    (entry) => entry.targetGroup === row.group_id,
  );
  if (
    corrected &&
    (corrected.fixture.orgAlias !== alias || corrected.orgType !== type)
  )
    throw new Error(
      `Corrected org fixture disagrees with operation: ${row.id}`,
    );
  return { alias, type };
}

export function assertProjectedInput(row, projected) {
  const state = row.request.state;
  if (
    canonical(projected) !== canonical(state) ||
    canonical(guardrailRequest(projected, RFDT_BASE_MODEL)) !==
      canonical(row.request)
  )
    throw new Error(
      `Current sf-pi projected input differs from corrected row: ${row.id}`,
    );
}

function configureHostResolver(sf, sfDeps) {
  const detect = pathToFileURL(
    resolve(sf, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stub = pathToFileURL(
    resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
  ).href;
  const parent = pathToFileURL(
    resolve(sfDeps, "__c6_corrected_host_resolver__.mjs"),
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
        resolved = nextResolve(specifier, { ...context, parentURL: parent });
      }
      return resolved.url === detect
        ? { url: stub, shortCircuit: true }
        : resolved;
    },
  });
}

function restoreFixture(
  row,
  fixture,
  cwd,
  clearSharedSfEnvironment,
  restoreFromSessionEntries,
) {
  clearSharedSfEnvironment(cwd);
  if (!fixture) return;
  const env = {
    cli: { installed: true, version: "2.0.0" },
    project: { detected: true },
    config: {
      hasTargetOrg: true,
      targetOrg: fixture.alias,
      location: "Global",
    },
    org: {
      detected: true,
      alias: fixture.alias,
      username: `${fixture.alias.toLowerCase()}@example.test`,
      orgType: fixture.type,
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

const knownFallback = (error) => {
  const message = error instanceof Error ? error.message : "";
  return message ===
    "Jev Salesforce org identity unverified; using Safety Kernel fallback" ||
    message ===
      "Jev Salesforce org target is ambiguous; using Safety Kernel fallback" ||
    /^Incomplete Jev risk input(?::|$)/.test(message) ||
    /^Jev risk input exceeds (?:structural limits|byte limit(?: after host facts)?)$/.test(
      message,
    ) ||
    message === "Invalid Unicode in Jev risk input"
    ? message.slice(0, 512)
    : null;
};
const bump = (record, key) => {
  record[key] = (record[key] ?? 0) + 1;
};

export async function replayCorrectedPool({ rows, sf, sfDeps }) {
  if (gitHead(sf) !== sfCommit)
    throw new Error("sf-pi commit differs from pinned C5 source");
  if (!(await stat(sfDeps)).isDirectory())
    throw new Error("--sf-deps must be an installed dependency directory");
  configureHostResolver(sf, sfDeps);
  const agentDir = await mkdtemp(resolve(tmpdir(), "c6-corrected-host-facts-"));
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
    const runtimeSha = getJevRiskBaselineSha256();
    if (runtimeSha !== sfRuntimeSha256)
      throw new Error("sf-pi runtime differs from pinned C5 baseline");
    const bySplit = {
      train: {
        total: 0,
        matched: 0,
        policyFloor: 0,
        ineligible: 0,
        fallback: 0,
      },
      validation: {
        total: 0,
        matched: 0,
        policyFloor: 0,
        ineligible: 0,
        fallback: 0,
      },
    };
    const baselineActions = { train: {}, validation: {} };
    const labelComparisons = {
      train: { agree: 0, disagree: 0 },
      validation: { agree: 0, disagree: 0 },
    };
    const fallbackReasons = {};
    const ids = new Set();
    const groups = new Map();
    for (const row of rows) {
      if (row?.split !== "train" && row?.split !== "validation")
        throw new Error("Corrected host replay refuses TEST or unknown split");
      if (
        typeof row.id !== "string" ||
        ids.has(row.id) ||
        typeof row.group_id !== "string" ||
        !row.group_id
      )
        throw new Error("Duplicate or malformed corrected row ID/group");
      ids.add(row.id);
      if (groups.has(row.group_id) && groups.get(row.group_id) !== row.split)
        throw new Error("Corrected operation group crosses splits");
      groups.set(row.group_id, row.split);
      const fixture = declaredOrgFixture(row);
      const state = row.request.state;
      const cwd = "/example/project";
      restoreFixture(
        row,
        fixture,
        cwd,
        clearSharedSfEnvironment,
        restoreFromSessionEntries,
      );
      const input = {
        toolName: state.toolName,
        input: state.input,
        cwd,
        sessionId: `c6-corrected-${row.id}`,
        config: readBundledConfig(),
      };
      const baseline = await evaluateSafety(input);
      const baselineAction = baseline?.action ?? "allow";
      bump(baselineActions[row.split], baselineAction);
      const label = row.targets?.risk?.answer;
      if (label !== "allow" && label !== "confirm")
        throw new Error(`Invalid corrected rubric label: ${row.id}`);
      labelComparisons[row.split][
        baselineAction === label ? "agree" : "disagree"
      ]++;
      bySplit[row.split].total++;
      if (!jevRiskEligible(input)) {
        bySplit[row.split].ineligible++;
        continue;
      }
      if (jevRiskPolicyFloor(input, baseline)) {
        bySplit[row.split].policyFloor++;
        continue;
      }
      let projected;
      try {
        projected = await prepareJevRiskInput(input, baseline);
      } catch (error) {
        const reason = knownFallback(error);
        if (!reason) throw error;
        bySplit[row.split].fallback++;
        bump(fallbackReasons, reason);
        continue;
      }
      assertProjectedInput(row, projected);
      bySplit[row.split].matched++;
    }
    if (
      rows.length !== 257 ||
      bySplit.train.total !== 161 ||
      bySplit.validation.total !== 96 ||
      calculateJevRiskBaselineIdentity().sha256 !== runtimeSha ||
      gitHead(sf) !== sfCommit
    )
      throw new Error(
        "Corrected replay count or sf-pi source changed during run",
      );
    return {
      bySplit,
      baselineActions,
      labelComparisons,
      fallbackReasons,
      groups: groups.size,
      sfPiRuntimeSha256: runtimeSha,
    };
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      receipt: { type: "string" },
      "merge-receipt": { type: "string" },
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  if (
    [
      "dataset",
      "receipt",
      "merge-receipt",
      "sf-pi",
      "sf-deps",
      "output-dir",
    ].some((key) => !values[key])
  )
    throw new Error(
      "Required: --dataset C6_JSONL --receipt C6_JSON --merge-receipt C5_JSON --sf-pi DIR --sf-deps NODE_MODULES --output-dir FRESH_BUILD_DIR",
    );
  const paths = {
    datasetPath: resolve(values.dataset),
    receiptPath: resolve(values.receipt),
    mergeReceiptPath: resolve(values["merge-receipt"]),
  };
  const outputDir = resolve(values["output-dir"]);
  if (
    !inside(outputDir, outputRoot) ||
    !basename(outputDir).startsWith("candidate-6-corrected-host-preflight-")
  )
    throw new Error(
      "Output must be a fresh candidate-6-corrected-host-preflight-* directory under .build/guardrail",
    );
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const verified = await verifyCorrectedSource(paths);
  const [scriptBytes, scorerBytes, stubBytes, sfLockBytes] = await Promise.all([
    readFile(fileURLToPath(import.meta.url)),
    readFile(resolve(root, "dist/guardrail.js")),
    readFile(resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs")),
    readFile(resolve(sf, "package-lock.json")),
  ]);
  if (sha(stubBytes) !== discoveryStubSha256)
    throw new Error("Mock discovery stub differs from reviewed C5 source");
  const result = await replayCorrectedPool({ rows: verified.rows, sf, sfDeps });
  const end = await verifyCorrectedSource(paths);
  if (
    !end.datasetBytes.equals(verified.datasetBytes) ||
    !end.receiptBytes.equals(verified.receiptBytes) ||
    !end.mergeBytes.equals(verified.mergeBytes) ||
    !end.sourceBytes.equals(verified.sourceBytes) ||
    sha(await readFile(fileURLToPath(import.meta.url))) !== sha(scriptBytes) ||
    sha(await readFile(resolve(root, "dist/guardrail.js"))) !==
      sha(scorerBytes) ||
    sha(
      await readFile(
        resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
      ),
    ) !== sha(stubBytes) ||
    sha(await readFile(resolve(sf, "package-lock.json"))) !== sha(sfLockBytes)
  )
    throw new Error(
      "Corrected replay source or host assets changed during run",
    );
  const receipt = {
    version: 1,
    purpose: "candidate6_corrected_development_host_preflight",
    qualification: false,
    trainingReady: false,
    heldOutTestUsed: false,
    testRows: 0,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    mockedHostFacts: true,
    fixturePreconditionsExecuted: false,
    humanLabelReviewed: false,
    collisionScreenDisjointProven: false,
    validationRole: "historical_diagnostic_only",
    ...result,
    source: {
      correctedDataset: paths.datasetPath,
      correctedDatasetSha256: correctedSha256,
      correctionReceipt: paths.receiptPath,
      correctionReceiptSha256: sha(verified.receiptBytes),
      c5MergeReceipt: paths.mergeReceiptPath,
      c5MergeReceiptSha256: sha(verified.mergeBytes),
      c5MergedDatasetSha256: sourceSha256,
      correctionScriptSha256,
      preflightScriptSha256: sha(scriptBytes),
      sfPiCommit: sfCommit,
      sfPiRuntimeSha256: result.sfPiRuntimeSha256,
      sfPackageLockSha256: sha(sfLockBytes),
      sfDependenciesDirectory: sfDeps,
      mockDiscoveryStubSha256: sha(stubBytes),
      scorerDistributionSha256: sha(scorerBytes),
      scorerProtocolSha256: protocolSha256,
      rfdtBaseModel: RFDT_BASE_MODEL,
      rfdtBaseRevision: RFDT_BASE_REVISION,
    },
  };
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDir, { recursive: false });
  try {
    await writeFile(
      resolve(outputDir, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  console.log(
    JSON.stringify({
      receipt: resolve(outputDir, "receipt.json"),
      bySplit: result.bySplit,
      baselineActions: result.baselineActions,
      labelComparisons: result.labelComparisons,
      qualification: false,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
