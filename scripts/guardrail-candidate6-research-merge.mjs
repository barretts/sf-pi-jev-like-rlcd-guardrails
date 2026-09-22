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
    ".build/guardrail/candidate-6-dev-corrections-v5-20260922/merged-train-validation.jsonl",
  ),
  correctionReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-dev-corrections-v5-20260922/receipt.json",
  ),
  correctedHostReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-corrected-host-preflight-v3-20260922/receipt.json",
  ),
  supplement: resolve(
    root,
    ".build/guardrail/candidate-6-supplement-preflight-dd97a1a/train.jsonl",
  ),
  supplementReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-supplement-preflight-dd97a1a/receipt.json",
  ),
  proposal: resolve(
    root,
    ".build/guardrail/candidate-6-proposal-projection-20260922-dd97a1a-v2/train.jsonl",
  ),
  proposalReceipt: resolve(
    root,
    ".build/guardrail/candidate-6-proposal-projection-20260922-dd97a1a-v2/receipt.json",
  ),
  augmentationFixture: resolve(
    root,
    "fixtures/guardrail/candidate6/train-augmentation.json",
  ),
  browserFixture: resolve(
    root,
    "fixtures/guardrail/candidate6/browser-train-proposal.json",
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
  validManifest: resolve(root, "blind-c6-20260922/c6-valid-v4.manifest.json"),
  validData: resolve(root, "blind-c6-20260922/c6-valid-v4.json"),
  testManifest: resolve(root, "blind-c6-20260922/c6-test-v3.manifest.json"),
  testData: resolve(root, "blind-c6-20260922/c6-test-v3.json"),
  blindSchema: resolve(root, "blind-c6-20260922/c6-case-v2.schema.json"),
  screen: resolve(root, "blind-c6-20260922/screen-c6.py"),
});
const pin = Object.freeze({
  corrected: "cb50f35f9d0eedf7c366b5093d216839b26c1c7a7103902b81a368addd8a5f09",
  correctionReceipt:
    "9a7867c2c0a1ca906666a88704819c71abb1f0fd5849e7b14ccd84942f87e3e3",
  correctedHostReceipt:
    "62917d095a69c7a27e64da59b9d256c2221c2967764e3a626a5f00252de3a0f7",
  supplement:
    "1976ec21b7e7c3fec3d76d635a754d2db8c620ae0f8c206719adc919992cfeeb",
  supplementReceipt:
    "d61128c1ed102b738d1e96ca7256a05ae63a428488e1ca30dc752700c800d7b1",
  supplementFixture:
    "f6bcd88d9dc546db1f7f7236db55ad5559c82fce3643f18af2d316a9419a2443",
  proposal: "8e8ab3fcb0215fe728a1426777e94ebd30486992c11f9a5261d1b2d25ca48c09",
  proposalReceipt:
    "4cba69e932c83723e3e03248a03d546145e73410b56333c552a4ab7367f6b3df",
  augmentationFixture:
    "c8538642a18468d5e4607bd650a5dbd8c728791f142ed6496e74434ec7e92409",
  browserFixture:
    "0066675417d3e6ffeb16af14f9e2571b23eb435f4b52a947ab5cc2c33b681a8d",
  c5Merged: "f97050f508c45c16bf14b8c68aae50cf51e43404056bffe25cb91dd1365983ea",
  c5MergeReceipt:
    "0df13b4af10c9dae48248f23b10953fc66bafbd02cb1231a75e96dec5ce86a10",
  validManifest:
    "4696aee64fe8e91cbc3fb471e80bb1c741223314ee98841d3c276e911f916de7",
  validData: "b172cc2c07188c206209e4be1a770fc0cb7484539b770ea0d021d14c30f5dd87",
  testManifest:
    "249311991301cf25252f7563b89fcccc59949442debd97099baaa7c551788249",
  testData: "82cfe17e0fa4bb4ce397f60e0d8479fe9ad0d1aa7aa71807b39b69113ad359c9",
  blindSchema:
    "e204e21d086bf4a4bebee0c7c14440ea83ed9509228ec3cab03ba3d55202c376",
  screen: "d410122a9c9b4c87da008c66447185b6ada3c5efcd9f36d72556e8dac975b0db",
  sfPiCommit: "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
  sfPiRuntime:
    "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4",
  scorerDistribution:
    "451e617f598d2b2e6bb5a708b3725f6b0cf3bde129cfc2a7ef7d1915618c34e2",
  correctionScript:
    "cea39cfe8140e6289de07e33ff61c740fc113a2ce1f975700b92262ad68386c7",
  correctedHostScript:
    "c74e31141b7f8787a0c2042fab0be59c8ecd1ce377914439c0644e134e3c6afe",
  supplementPreflightScript:
    "2ea7c998afa242e5021b78da48957aa75c998e6ea4a0818568ced03a4bd2b129",
  proposalProjectionScript:
    "1d7bcccf6894cd6298e36fad6ae50b8e8730aaf0d1f708b57bff03b92e87b393",
  c5ScoringProtocol:
    "b249564d783087cd105fec3c1f92c4ce93201c1ae06958e8498b35aa2988cd8e",
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
      (row.request?.state?.toolName?.startsWith("sf_browser_") &&
        row.request.state.toolName !== "sf_browser_click") ||
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

export function partitionResearchRows(
  correctedRows,
  supplementRows,
  proposalRows,
) {
  const trainRows = [
    ...correctedRows.filter((row) => row.split === "train"),
    ...supplementRows,
    ...proposalRows,
  ];
  const historicalDiagnosticRows = correctedRows.filter(
    (row) => row.split === "validation",
  );
  const train = validateResearchRows(trainRows, ["train"]);
  const historical = validateResearchRows(historicalDiagnosticRows, [
    "validation",
  ]);
  if (
    trainRows.length !== 186 ||
    historicalDiagnosticRows.length !== 96 ||
    train.splits.train !== 186 ||
    historical.splits.validation !== 96 ||
    [...train.groups.keys()].some((group) => historical.groups.has(group)) ||
    [...train.ids].some((id) => historical.ids.has(id)) ||
    [...train.inputs].some((input) => historical.inputs.has(input))
  )
    throw new Error("C6 TRAIN and historical diagnostic isolation changed");
  return { trainRows, historicalDiagnosticRows };
}

function requireReceiptChain(correction, host, supplement, proposal) {
  const c = correction.source;
  const h = host.source;
  const s = supplement.source;
  const p = proposal.source;
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
    c.scoringProtocolSha256 !== pin.c5ScoringProtocol ||
    correction.output.scoringProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
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
    proposal.purpose !==
      "candidate6_proposal_train_only_model_free_projection" ||
    proposal.qualification !== false ||
    proposal.trainingReady !== false ||
    proposal.blindSplitScreened !== false ||
    proposal.humanLabelReviewed !== false ||
    proposal.mockedHostFacts !== true ||
    proposal.modelCalls !== 0 ||
    proposal.externalOperationsExecuted !== 0 ||
    proposal.browserInputsDispatched !== 0 ||
    proposal.trainRows !== 10 ||
    proposal.trainGroups !== 5 ||
    proposal.validationRows !== 0 ||
    proposal.testRows !== 0 ||
    proposal.labels?.allow !== 5 ||
    proposal.labels?.confirm !== 5 ||
    proposal.baselineActions?.allow !== 10 ||
    proposal.baselineActions?.confirm !== 0 ||
    proposal.baselineActions?.block !== 0 ||
    proposal.dataset?.file !== source.proposal ||
    proposal.dataset.sha256 !== pin.proposal ||
    p?.augmentationSha256 !== pin.augmentationFixture ||
    p.browserProposalSha256 !== pin.browserFixture ||
    p.preparationScriptSha256 !== pin.proposalProjectionScript ||
    h.sfPiCommit !== pin.sfPiCommit ||
    s.sfPiCommit !== pin.sfPiCommit ||
    p.sfPiCommit !== pin.sfPiCommit ||
    h.sfPiRuntimeSha256 !== pin.sfPiRuntime ||
    s.sfPiRuntimeSha256 !== pin.sfPiRuntime ||
    p.sfPiRuntimeSha256 !== pin.sfPiRuntime ||
    h.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    s.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    p.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    h.scorerDistributionSha256 !== pin.scorerDistribution ||
    s.scorerDistributionSha256 !== pin.scorerDistribution ||
    p.scorerDistributionSha256 !== pin.scorerDistribution ||
    h.rfdtBaseModel !== RFDT_BASE_MODEL ||
    s.rfdtBaseModel !== RFDT_BASE_MODEL ||
    p.rfdtBaseModel !== RFDT_BASE_MODEL ||
    h.rfdtBaseRevision !== RFDT_BASE_REVISION ||
    s.rfdtBaseRevision !== RFDT_BASE_REVISION ||
    p.rfdtBaseRevision !== RFDT_BASE_REVISION ||
    h.sfDependenciesDirectory !== s.sfDependenciesDirectory ||
    h.sfDependenciesDirectory !== p.sfDependenciesDirectory ||
    h.sfPackageLockSha256 !== p.sfPackageLockSha256 ||
    h.sfPackageLockSha256 !== s.sfPackageLockSha256 ||
    s.sfDependenciesLockSha256 !== p.sfDependenciesLockSha256 ||
    h.mockDiscoveryStubSha256 !== p.mockDiscoveryStubSha256 ||
    h.mockDiscoveryStubSha256 !== s.mockDiscoveryStubSha256
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
      "--left-append",
      source.proposal,
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
  assertAggregateScreen(report, 186, rightCount);
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
    proposalBytes,
    proposalReceiptBytes,
  ] = await Promise.all([
    readPinned("corrected"),
    readPinned("correctionReceipt"),
    readPinned("correctedHostReceipt"),
    readPinned("supplement"),
    readPinned("supplementReceipt"),
    readPinned("proposal"),
    readPinned("proposalReceipt"),
  ]);
  const [
    c5MergedBytes,
    c5MergeReceiptBytes,
    supplementFixtureBytes,
    augmentationFixtureBytes,
    browserFixtureBytes,
    screenBytes,
    schemaBytes,
    validManifestBytes,
    testManifestBytes,
  ] = await Promise.all([
    readPinned("c5Merged"),
    readPinned("c5MergeReceipt"),
    readPinned("supplementFixture"),
    readPinned("augmentationFixture"),
    readPinned("browserFixture"),
    readPinned("screen"),
    readPinned("blindSchema"),
    readPinned("validManifest"),
    readPinned("testManifest"),
  ]);
  const correction = JSON.parse(correctionReceiptBytes);
  const correctedHost = JSON.parse(correctedHostReceiptBytes);
  const supplement = JSON.parse(supplementReceiptBytes);
  const proposal = JSON.parse(proposalReceiptBytes);
  requireReceiptChain(correction, correctedHost, supplement, proposal);
  // The sealed data files are hashed as opaque byte streams here. Only the
  // request-only screen process parses them, and it prints aggregate counts.
  const validManifest = JSON.parse(validManifestBytes);
  const testManifest = JSON.parse(testManifestBytes);
  assertBlindManifest(
    validManifest,
    "valid",
    source.validData,
    pin.validData,
    62,
  );
  assertBlindManifest(testManifest, "test", source.testData, pin.testData, 55);
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
    proposalScriptBytes,
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
    readFile(
      resolve(root, "scripts/guardrail-candidate6-proposal-projection.mjs"),
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
    sha(proposalScriptBytes) !== pin.proposalProjectionScript ||
    GUARDRAIL_PROTOCOL_SHA256 !== correction.output.scoringProtocolSha256 ||
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
  const proposalRows = parseJsonl(proposalBytes, "C6 TRAIN proposals");
  const base = validateResearchRows(correctedRows, ["train", "validation"]);
  const extra = validateResearchRows(supplementRows, ["train"]);
  const proposals = validateResearchRows(proposalRows, ["train"]);
  if (
    correctedRows.length !== 254 ||
    base.splits.train !== 158 ||
    base.splits.validation !== 96 ||
    supplementRows.length !== 18 ||
    extra.splits.train !== 18 ||
    proposalRows.length !== 10 ||
    proposals.splits.train !== 10 ||
    [...extra.ids].some((id) => base.ids.has(id)) ||
    [...extra.groups.keys()].some((group) => base.groups.has(group)) ||
    [...extra.inputs].some((input) => base.inputs.has(input)) ||
    [...proposals.ids].some((id) => base.ids.has(id) || extra.ids.has(id)) ||
    [...proposals.groups.keys()].some(
      (group) => base.groups.has(group) || extra.groups.has(group),
    ) ||
    [...proposals.inputs].some(
      (input) => base.inputs.has(input) || extra.inputs.has(input),
    )
  )
    throw new Error(
      "C6 TRAIN supplement overlaps or changes corrected development pool",
    );
  const { trainRows, historicalDiagnosticRows } = partitionResearchRows(
    correctedRows,
    supplementRows,
    proposalRows,
  );
  const merged = validateResearchRows(
    [...trainRows, ...historicalDiagnosticRows],
    ["train", "validation"],
  );
  if (
    merged.splits.train !== 186 ||
    merged.splits.validation !== 96 ||
    merged.splits.test !== 0 ||
    merged.groups.size !== 94
  )
    throw new Error(
      "C6 merged RFDT TRAIN / historical VALID group counts changed",
    );
  const validScreen = screenAgainstBlind(
    source.validData,
    source.validManifest,
    62,
  );
  const testScreen = screenAgainstBlind(
    source.testData,
    source.testManifest,
    55,
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
    sha(await readFile(source.proposal)) !== pin.proposal ||
    sha(await readFile(source.correctionReceipt)) !== pin.correctionReceipt ||
    sha(await readFile(source.correctedHostReceipt)) !==
      pin.correctedHostReceipt ||
    sha(await readFile(source.supplementReceipt)) !== pin.supplementReceipt ||
    sha(await readFile(source.proposalReceipt)) !== pin.proposalReceipt ||
    sha(await readFile(source.supplementFixture)) !== pin.supplementFixture ||
    sha(await readFile(source.augmentationFixture)) !==
      pin.augmentationFixture ||
    sha(await readFile(source.browserFixture)) !== pin.browserFixture ||
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
      train: 186,
      historicalDiagnosticValidation: 96,
      prospectiveBlindValidation: 0,
      test: 0,
      groups: 94,
    },
    selection: {
      mode: "validation_only",
      historicalValidationRole: "diagnostic_only_not_candidate_selection",
      prospectiveSelectionSplit: "sealed_c6_valid_v4_not_in_dataset",
      heldOutSplit: "sealed_c6_test_v3_not_in_dataset",
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
      proposalDataset: { file: source.proposal, sha256: pin.proposal },
      proposalReceipt: {
        file: source.proposalReceipt,
        sha256: pin.proposalReceipt,
      },
      augmentationFixtureSha256: sha(augmentationFixtureBytes),
      browserFixtureSha256: sha(browserFixtureBytes),
      proposalProjectionScriptSha256: sha(proposalScriptBytes),
      c5MergedDatasetSha256: sha(c5MergedBytes),
      c5MergeReceiptSha256: sha(c5MergeReceiptBytes),
      screenScriptSha256: sha(screenBytes),
      blindSchemaSha256: sha(schemaBytes),
      blindValid: {
        manifestSha256: pin.validManifest,
        dataSha256: pin.validData,
        caseCount: 62,
      },
      blindTest: {
        manifestSha256: pin.testManifest,
        dataSha256: pin.testData,
        caseCount: 55,
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
