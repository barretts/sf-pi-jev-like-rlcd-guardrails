#!/usr/bin/env node
/** Source-pinned, model-free C6 TRAIN handoff with separate historical diagnostics. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  RFDT_BASE_MODEL,
  RFDT_BASE_REVISION,
  validateRfdtExample,
} from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const source = Object.freeze({
  corrected: resolve(
    root,
    ".build/guardrail/candidate-6-dev-corrections-v4-20260922/merged-train-validation.jsonl",
  ),
  correctionReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-dev-corrections-v4-20260922/receipt.json",
  ),
  correctedHostReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-corrected-host-preflight-v2-20260922/receipt.json",
  ),
  supplement: resolve(
    root,
    ".build/guardrail/candidate-6-supplement-preflight-20260922-c/train.jsonl",
  ),
  supplementReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-supplement-preflight-20260922-c/receipt.json",
  ),
  supplementFixture: resolve(
    root,
    "fixtures/guardrail/candidate6/train-supplement.json",
  ),
  c5Merged: resolve(
    root,
    ".build/guardrail/candidate-5-research-split-e456e1c9-20260922/merged-train-validation.jsonl",
  ),
  c5MergeReceipt: resolve(
    root,
    ".build/guardrail/candidate-5-research-split-e456e1c9-20260922/merge-receipt.json",
  ),
  validManifest: resolve(root, "blind-c6-20260922/c6-valid-v3.manifest.json"),
  validData: resolve(root, "blind-c6-20260922/c6-valid-v3.json"),
  testManifest: resolve(root, "blind-c6-20260922/c6-test-v2.manifest.json"),
  testData: resolve(root, "blind-c6-20260922/c6-test-v2.json"),
  blindSchema: resolve(root, "blind-c6-20260922/c6-case.schema.json"),
  screen: resolve(root, "blind-c6-20260922/screen-c6.py"),
});
const pin = Object.freeze({
  corrected: "cb50f35f9d0eedf7c366b5093d216839b26c1c7a7103902b81a368addd8a5f09",
  correctionReceipt:
    "cd2a59d1a6592335a53b38e45c9fd6d9f8d70dc7fd19e86e0920ac0e4effdc07",
  correctedHostReceipt:
    "75b78042480944231ecb59edbdde8daba8d0a9008c7c751a981d4a38ba7a5aab",
  supplement:
    "1976ec21b7e7c3fec3d76d635a754d2db8c620ae0f8c206719adc919992cfeeb",
  supplementReceipt:
    "f280b4bc41ffd571697b1360fbfba4e6092dbaf0e3fe421c3431c675e43dcdea",
  supplementFixture:
    "9437cef2872fcba123b4f6b7a5fc720e14f53779b748cdf38ad52307ea5aec53",
  c5Merged: "f97050f508c45c16bf14b8c68aae50cf51e43404056bffe25cb91dd1365983ea",
  c5MergeReceipt:
    "0df13b4af10c9dae48248f23b10953fc66bafbd02cb1231a75e96dec5ce86a10",
  validManifest:
    "02554224fbad8055fdb2a03aadd256d63748121a5eb4ba53ffd58fa4fa45b079",
  validData: "da14b83047094971dfe5083a5ea2fd437c01a44600ce9d9a196cb6dd62287905",
  testManifest:
    "dbac9247e7df67e70bd8ace9a9e0e15bd382379f344ff3d1a7be7b2b4dff1543",
  testData: "7a0fa5fca18fbcffb5824011884359ceccfa139a42480499b2197a26bb3fc9d1",
  blindSchema:
    "99847a1a8377c2e4cb887f6fbe5d5010f60b8f7eb5fd846c943bd6167be10e12",
  screen: "7f13eaffb1ece2066351343c8f7b486973de471e4e40065be4e3560245168122",
  sfPiCommit: "e456e1c9c7c0c9b97ccb08f4084558e5cbcd7a8c",
  sfPiRuntime:
    "b1dd0309a789b30c98a7d14a01d843fc3ab199d1542d023ce97c10cbcd2a9e7d",
  scorerDistribution:
    "1f33e5f22604ed1421a14e7c703d6b777fa08930d14467f08f2f6c2acbc23fe9",
  correctionScript:
    "d354dfb7cf0ca07463691eb04bff188ff13f8d4402418347d0353472afc33782",
  correctedHostScript:
    "94ea7770ca014e2491aad723bd4d5762b79b90434559abfe4575290f6ad93824",
  supplementPreflightScript:
    "2ea7c998afa242e5021b78da48957aa75c998e6ea4a0818568ced03a4bd2b129",
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );

export function assertPinned(bytes, expected, name) {
  if (sha(bytes) !== expected) throw new Error(`${name} SHA-256 mismatch`);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function readPinned(name) {
  const bytes = await readFile(source[name]);
  assertPinned(bytes, pin[name], name);
  return bytes;
}

function parseJsonl(bytes, name) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${name} lacks final newline`);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

export function validateResearchRows(rows, allowedSplits) {
  const ids = new Set();
  const groups = new Map();
  const inputs = new Set();
  const splits = { train: 0, validation: 0, test: 0 };
  for (const row of rows) {
    validateRfdtExample(row);
    if (
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      !allowedSplits.includes(row.split) ||
      row.request?.model !== RFDT_BASE_MODEL ||
      row.request?.state?.version !== 2 ||
      row.request?.state?.toolName?.startsWith("sf_browser_") ||
      row.request?.options?.template_version !== "v2" ||
      row.request?.questions?.length !== 1 ||
      row.request.questions[0]?.id !== "risk" ||
      row.request.questions[0]?.type !== "choice" ||
      canonical(
        row.request.questions[0]?.criteria?.map((criterion) => criterion.id),
      ) !== canonical(["allow", "confirm"]) ||
      !["allow", "confirm"].includes(row.targets?.risk?.answer) ||
      canonical(row.targets) !==
        canonical({ risk: { answer: row.targets?.risk?.answer } }) ||
      canonical(row.target_provenance) !==
        canonical({ risk: { source: "supplied" } }) ||
      row.regression !== undefined ||
      canonical(row.request) !==
        canonical(guardrailRequest(row.request.state, RFDT_BASE_MODEL))
    )
      throw new Error("Invalid, changed, or duplicate C6 research row");
    ids.add(row.id);
    const prior = groups.get(row.group_id);
    if (prior && prior !== row.split)
      throw new Error("C6 operation group crosses splits");
    groups.set(row.group_id, row.split);
    const input = canonical(row.request.state);
    if (inputs.has(input))
      throw new Error("C6 model input repeats across rows");
    inputs.add(input);
    splits[row.split]++;
  }
  return { ids, groups, inputs, splits };
}

export function partitionResearchRows(correctedRows, supplementRows) {
  const trainRows = [
    ...correctedRows.filter((row) => row.split === "train"),
    ...supplementRows,
  ];
  const historicalDiagnosticRows = correctedRows.filter(
    (row) => row.split === "validation",
  );
  const train = validateResearchRows(trainRows, ["train"]);
  const historical = validateResearchRows(historicalDiagnosticRows, [
    "validation",
  ]);
  if (
    trainRows.length !== 176 ||
    historicalDiagnosticRows.length !== 96 ||
    train.splits.train !== 176 ||
    historical.splits.validation !== 96 ||
    [...train.groups.keys()].some((group) => historical.groups.has(group)) ||
    [...train.ids].some((id) => historical.ids.has(id)) ||
    [...train.inputs].some((input) => historical.inputs.has(input))
  )
    throw new Error("C6 TRAIN and historical diagnostic isolation changed");
  return { trainRows, historicalDiagnosticRows };
}

function requireReceiptChain(correction, host, supplement) {
  const c = correction.source;
  const h = host.source;
  const s = supplement.source;
  if (
    correction.purpose !==
      "nonqualifying_candidate6_corrected_development_pool" ||
    correction.qualification !== false ||
    correction.trainingReady !== false ||
    correction.heldOutTestUsed !== false ||
    correction.hostReplayRequired !== true ||
    correction.humanLabelReviewRequired !== true ||
    correction.collisionScreen?.disjointProven !== false ||
    correction.split?.train !== 158 ||
    correction.split?.validation !== 96 ||
    correction.split?.test !== 0 ||
    correction.output?.file !== source.corrected ||
    correction.output.sha256 !== pin.corrected ||
    c?.input !== source.c5Merged ||
    c.inputSha256 !== pin.c5Merged ||
    c.scriptSha256 !== pin.correctionScript ||
    c.scoringProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    host.purpose !== "candidate6_corrected_development_host_preflight" ||
    host.qualification !== false ||
    host.trainingReady !== false ||
    host.heldOutTestUsed !== false ||
    host.modelCalls !== 0 ||
    host.externalOperationsExecuted !== 0 ||
    host.validationRole !== "historical_diagnostic_only" ||
    host.collisionScreenDisjointProven !== false ||
    host.humanLabelReviewed !== false ||
    host.bySplit?.train?.total !== 158 ||
    host.bySplit.train.matched !== 158 ||
    host.bySplit?.validation?.total !== 96 ||
    host.bySplit.validation.matched !== 96 ||
    [host.bySplit.train, host.bySplit.validation].some((part) =>
      ["policyFloor", "ineligible", "fallback"].some((key) => part[key] !== 0),
    ) ||
    h?.correctedDataset !== source.corrected ||
    h.correctedDatasetSha256 !== pin.corrected ||
    h.correctionReceipt !== source.correctionReceipt ||
    h.correctionReceiptSha256 !== pin.correctionReceipt ||
    h.c5MergeReceipt !== source.c5MergeReceipt ||
    h.c5MergeReceiptSha256 !== pin.c5MergeReceipt ||
    h.c5MergedDatasetSha256 !== pin.c5Merged ||
    h.correctionScriptSha256 !== pin.correctionScript ||
    h.preflightScriptSha256 !== pin.correctedHostScript ||
    supplement.purpose !== "candidate6_supplement_train_only_host_preflight" ||
    supplement.qualification !== false ||
    supplement.trainingReady !== false ||
    supplement.blindSplitScreened !== false ||
    supplement.humanLabelReviewed !== false ||
    supplement.modelCalls !== 0 ||
    supplement.externalOperationsExecuted !== 0 ||
    supplement.trainRows !== 18 ||
    supplement.trainGroups !== 8 ||
    supplement.validationRows !== 0 ||
    supplement.testRows !== 0 ||
    supplement.dataset?.file !== source.supplement ||
    supplement.dataset.sha256 !== pin.supplement ||
    s?.supplementFile !== source.supplementFixture ||
    s.supplementSha256 !== pin.supplementFixture ||
    s.preparationScriptSha256 !== pin.supplementPreflightScript ||
    h.sfPiCommit !== pin.sfPiCommit ||
    s.sfPiCommit !== pin.sfPiCommit ||
    h.sfPiRuntimeSha256 !== pin.sfPiRuntime ||
    s.sfPiRuntimeSha256 !== pin.sfPiRuntime ||
    h.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    s.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    h.scorerDistributionSha256 !== pin.scorerDistribution ||
    s.scorerDistributionSha256 !== pin.scorerDistribution ||
    h.rfdtBaseModel !== RFDT_BASE_MODEL ||
    s.rfdtBaseModel !== RFDT_BASE_MODEL ||
    h.rfdtBaseRevision !== RFDT_BASE_REVISION ||
    s.rfdtBaseRevision !== RFDT_BASE_REVISION ||
    h.sfDependenciesDirectory !== s.sfDependenciesDirectory
  )
    throw new Error(
      "C6 source receipt chain or nonqualification status changed",
    );
}

function assertBlindManifest(
  manifest,
  expectedSplit,
  expectedFile,
  expectedHash,
  expectedCount,
) {
  if (
    manifest.split !== expectedSplit ||
    manifest.case_count !== expectedCount ||
    (manifest.data_file ?? manifest.file) !== basename(expectedFile) ||
    (manifest.data_sha256 ?? manifest.file_sha256) !== expectedHash ||
    manifest.schema_sha256 !== pin.blindSchema
  )
    throw new Error("Active blind split manifest or byte seal changed");
}

export function assertAggregateScreen(report, leftCount, rightCount) {
  if (report.left_count !== leftCount || report.right_count !== rightCount)
    throw new Error("Blind request-only screen used the wrong row counts");
  for (const key of [
    "exact",
    "canonical",
    "groups",
    "templates",
    "same_effect",
  ]) {
    if (
      report.collisions?.[key]?.shared_keys !== 0 ||
      report.collisions[key].cross_pairs !== 0
    )
      throw new Error("Blind request-only collision screen found overlap");
  }
}

function screenAgainstBlind(right, manifest, rightCount) {
  const stdout = execFileSync(
    "python3",
    [
      source.screen,
      "--left",
      source.corrected,
      "--left-append",
      source.supplement,
      "--left-split",
      "train",
      "--right",
      right,
      "--right-manifest",
      manifest,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 8192 },
  );
  const report = JSON.parse(stdout);
  assertAggregateScreen(report, 176, rightCount);
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: { "sf-pi": { type: "string" }, "output-dir": { type: "string" } },
  });
  if (!values["sf-pi"] || !values["output-dir"])
    throw new Error(
      "Required: --sf-pi CURRENT_SF_CHECKOUT --output-dir FRESH_C6_BUILD_DIR",
    );
  const sf = resolve(values["sf-pi"]);
  const outputDir = resolve(values["output-dir"]);
  const rel = relative(buildRoot, outputDir);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !basename(outputDir).startsWith("candidate-6-research-merge-")
  )
    throw new Error(
      "C6 research output must be a fresh candidate-6-research-merge-* directory under .build/guardrail",
    );
  const [
    correctedBytes,
    correctionReceiptBytes,
    correctedHostReceiptBytes,
    supplementBytes,
    supplementReceiptBytes,
  ] = await Promise.all([
    readPinned("corrected"),
    readPinned("correctionReceipt"),
    readPinned("correctedHostReceipt"),
    readPinned("supplement"),
    readPinned("supplementReceipt"),
  ]);
  const [
    c5MergedBytes,
    c5MergeReceiptBytes,
    supplementFixtureBytes,
    screenBytes,
    schemaBytes,
    validManifestBytes,
    testManifestBytes,
  ] = await Promise.all([
    readPinned("c5Merged"),
    readPinned("c5MergeReceipt"),
    readPinned("supplementFixture"),
    readPinned("screen"),
    readPinned("blindSchema"),
    readPinned("validManifest"),
    readPinned("testManifest"),
  ]);
  const correction = JSON.parse(correctionReceiptBytes);
  const correctedHost = JSON.parse(correctedHostReceiptBytes);
  const supplement = JSON.parse(supplementReceiptBytes);
  requireReceiptChain(correction, correctedHost, supplement);
  // The sealed data files are hashed as opaque byte streams here. Only the
  // request-only screen process parses them, and it prints aggregate counts.
  const validManifest = JSON.parse(validManifestBytes);
  const testManifest = JSON.parse(testManifestBytes);
  assertBlindManifest(
    validManifest,
    "valid",
    source.validData,
    pin.validData,
    54,
  );
  assertBlindManifest(testManifest, "test", source.testData, pin.testData, 47);
  if (
    (await hashFile(source.validData)) !== pin.validData ||
    (await hashFile(source.testData)) !== pin.testData
  )
    throw new Error("Active blind split byte seal changed");
  const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sf,
    encoding: "utf8",
  }).trim();
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(sf, "extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ).href
  );
  const sfRuntimeSha256 = calculateJevRiskBaselineIdentity().sha256;
  const [
    scorerBytes,
    sfLockBytes,
    correctionScriptBytes,
    correctedHostScriptBytes,
    supplementScriptBytes,
    selfBytes,
  ] = await Promise.all([
    readFile(resolve(root, "dist/guardrail.js")),
    readFile(resolve(sf, "package-lock.json")),
    readFile(resolve(root, "scripts/guardrail-candidate6-corrections.mjs")),
    readFile(
      resolve(
        root,
        "scripts/guardrail-candidate6-corrected-host-preflight.mjs",
      ),
    ),
    readFile(
      resolve(root, "scripts/guardrail-candidate6-supplement-preflight.mjs"),
    ),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  if (
    sfCommit !== pin.sfPiCommit ||
    sfRuntimeSha256 !== pin.sfPiRuntime ||
    sha(scorerBytes) !== pin.scorerDistribution ||
    sha(sfLockBytes) !== correctedHost.source.sfPackageLockSha256 ||
    sha(sfLockBytes) !== supplement.source.sfPackageLockSha256 ||
    sha(correctionScriptBytes) !== pin.correctionScript ||
    sha(correctedHostScriptBytes) !== pin.correctedHostScript ||
    sha(supplementScriptBytes) !== pin.supplementPreflightScript ||
    GUARDRAIL_PROTOCOL_SHA256 !== correction.source.scoringProtocolSha256 ||
    RFDT_BASE_MODEL !== "google/gemma-3-1b-it"
  )
    throw new Error(
      "Current sf-pi source, scorer, protocol, or base model changed",
    );
  const correctedRows = parseJsonl(
    correctedBytes,
    "corrected C6 development pool",
  );
  const supplementRows = parseJsonl(supplementBytes, "C6 TRAIN supplement");
  const base = validateResearchRows(correctedRows, ["train", "validation"]);
  const extra = validateResearchRows(supplementRows, ["train"]);
  if (
    correctedRows.length !== 254 ||
    base.splits.train !== 158 ||
    base.splits.validation !== 96 ||
    supplementRows.length !== 18 ||
    extra.splits.train !== 18 ||
    [...extra.ids].some((id) => base.ids.has(id)) ||
    [...extra.groups.keys()].some((group) => base.groups.has(group)) ||
    [...extra.inputs].some((input) => base.inputs.has(input))
  )
    throw new Error(
      "C6 TRAIN supplement overlaps or changes corrected development pool",
    );
  const { trainRows, historicalDiagnosticRows } = partitionResearchRows(
    correctedRows,
    supplementRows,
  );
  const merged = validateResearchRows(
    [...trainRows, ...historicalDiagnosticRows],
    ["train", "validation"],
  );
  if (
    merged.splits.train !== 176 ||
    merged.splits.validation !== 96 ||
    merged.splits.test !== 0 ||
    merged.groups.size !== 89
  )
    throw new Error(
      "C6 merged RFDT TRAIN / historical VALID group counts changed",
    );
  const validScreen = screenAgainstBlind(
    source.validData,
    source.validManifest,
    54,
  );
  const testScreen = screenAgainstBlind(
    source.testData,
    source.testManifest,
    47,
  );
  if (
    (await hashFile(source.validData)) !== pin.validData ||
    (await hashFile(source.testData)) !== pin.testData ||
    sha(await readFile(source.validManifest)) !== pin.validManifest ||
    sha(await readFile(source.testManifest)) !== pin.testManifest ||
    sha(await readFile(source.blindSchema)) !== pin.blindSchema ||
    sha(await readFile(source.screen)) !== pin.screen ||
    sha(await readFile(source.corrected)) !== pin.corrected ||
    sha(await readFile(source.supplement)) !== pin.supplement ||
    sha(await readFile(source.correctionReceipt)) !== pin.correctionReceipt ||
    sha(await readFile(source.correctedHostReceipt)) !==
      pin.correctedHostReceipt ||
    sha(await readFile(source.supplementReceipt)) !== pin.supplementReceipt ||
    sha(await readFile(source.supplementFixture)) !== pin.supplementFixture ||
    sha(await readFile(fileURLToPath(import.meta.url))) !== sha(selfBytes)
  )
    throw new Error(
      "C6 source, screen, or blind byte seal changed during merge",
    );
  const trainBytes = Buffer.from(
    `${trainRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const historicalBytes = Buffer.from(
    `${historicalDiagnosticRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const trainPath = resolve(outputDir, "train.jsonl");
  const historicalPath = resolve(
    outputDir,
    "historical-diagnostic-valid.jsonl",
  );
  const receiptPath = resolve(outputDir, "receipt.json");
  const receipt = {
    version: 1,
    purpose: "candidate6_nonqualifying_research_train_handoff",
    qualification: false,
    trainingReady: false,
    humanLabelReviewed: false,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    prepareRfdtCalls: 0,
    rows: {
      train: 176,
      historicalDiagnosticValidation: 96,
      prospectiveBlindValidation: 0,
      test: 0,
      groups: 89,
    },
    selection: {
      mode: "validation_only",
      historicalValidationRole: "diagnostic_only_not_candidate_selection",
      prospectiveSelectionSplit: "sealed_c6_valid_v3_not_in_dataset",
      heldOutSplit: "sealed_c6_test_v2_not_in_dataset",
      trainingInput: "train.jsonl_only_after_further_admission",
      historicalDiagnosticInput: "separate_not_for_candidate_selection",
    },
    splitIsolation: {
      blindRequestOnlyScreen: { valid: validScreen, test: testScreen },
      blindByteSealsVerified: true,
      semanticDisjointnessProven: false,
      blindLabelsUsed: false,
      blindRowsEmitted: false,
    },
    source: {
      mergeScriptSha256: sha(selfBytes),
      correctedDataset: { file: source.corrected, sha256: pin.corrected },
      correctionReceipt: {
        file: source.correctionReceipt,
        sha256: pin.correctionReceipt,
      },
      correctedHostReceipt: {
        file: source.correctedHostReceipt,
        sha256: pin.correctedHostReceipt,
      },
      supplementDataset: { file: source.supplement, sha256: pin.supplement },
      supplementReceipt: {
        file: source.supplementReceipt,
        sha256: pin.supplementReceipt,
      },
      supplementFixtureSha256: pin.supplementFixture,
      c5MergedDatasetSha256: sha(c5MergedBytes),
      c5MergeReceiptSha256: sha(c5MergeReceiptBytes),
      screenScriptSha256: sha(screenBytes),
      blindSchemaSha256: sha(schemaBytes),
      blindValid: {
        manifestSha256: pin.validManifest,
        dataSha256: pin.validData,
        caseCount: 54,
      },
      blindTest: {
        manifestSha256: pin.testManifest,
        dataSha256: pin.testData,
        caseCount: 47,
      },
      sfPiCommit: sfCommit,
      sfPiRuntimeSha256: sfRuntimeSha256,
      scorerDistributionSha256: sha(scorerBytes),
      scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      rfdtBaseModel: RFDT_BASE_MODEL,
      rfdtBaseRevision: RFDT_BASE_REVISION,
    },
    datasets: {
      train: { file: trainPath, sha256: sha(trainBytes), split: "train" },
      historicalDiagnostic: {
        file: historicalPath,
        sha256: sha(historicalBytes),
        split: "validation",
        candidateSelectionAllowed: false,
      },
    },
  };
  await mkdir(buildRoot, { recursive: true });
  await mkdir(outputDir, { recursive: false });
  try {
    await writeFile(trainPath, trainBytes, { mode: 0o600, flag: "wx" });
    await writeFile(historicalPath, historicalBytes, {
      mode: 0o600,
      flag: "wx",
    });
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
      rows: receipt.rows,
      trainingReady: false,
      blindRequestCollisions: {
        valid: validScreen.collisions,
        test: testScreen.collisions,
      },
      trainSha256: receipt.datasets.train.sha256,
      historicalDiagnosticSha256: receipt.datasets.historicalDiagnostic.sha256,
      receipt: receiptPath,
    }),
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  await main();
