#!/usr/bin/env node
/** Case-level, source-pinned admission of the Candidate 6 research TRAIN rows. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const source = Object.freeze({
  train: resolve(
    buildRoot,
    "candidate-6-research-merge-20260922-final/train.jsonl",
  ),
  mergeReceipt: resolve(
    buildRoot,
    "candidate-6-research-merge-20260922-final/receipt.json",
  ),
  herdrReceipt: resolve(
    buildRoot,
    "candidate-6-herdr-pane-preflight-20260922-final-v3/receipt.json",
  ),
  herdrScript: resolve(
    root,
    "scripts/guardrail-candidate6-herdr-pane-preflight.mjs",
  ),
  herdrPreconditions: resolve(
    root,
    "fixtures/guardrail/candidate6/herdr-pane-preconditions.json",
  ),
  rubric: resolve(root, "fixtures/guardrail/RUBRIC.md"),
});
const pin = Object.freeze({
  train: "c88ca08e60f9a846a3b13aecd9a2290eef4993d08c9bb89e4ab869c05b83fe27",
  mergeReceipt:
    "d2c3a466e88c460cd9cf50d072cbbc81aa3b4f472a250e1cb9edad625d814568",
  herdrReceipt:
    "59127e1134730f60a2bf3bed58822eafa4f4dd1c17d9a18716ebee93a7ebef44",
  herdrScript:
    "8528f7281ff7a4c39f0445213ad167e2e3727f62e794baf107917ce853addb82",
  herdrPreconditions:
    "bbcd7dc49f5ef26263f279b7742079374c488aa3f78add1a813f9be9e26465d8",
  rubric: "cad1720e8ee31c153985ee98af010671d323917c0ef30c7ebd61c3832b318ae6",
  sfPiCommit: "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
  sfPiRuntimeSha256:
    "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4",
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Every one of the 62 source TRAIN groups has an explicit rubric disposition.
// Related syntax variants inherit only their own group's decision and stay
// together. The agent review found no reversed labels; the excluded groups
// have an unresolved executed effect or source-route premise.
const review = Object.freeze({
  "c5-apex-trace-production-status-vs-start": [
    "admit",
    "Read-only trace status versus a production trace-flag write.",
  ],
  "c5-draft-canvas-file-info-vs-delete": [
    "admit",
    "Slack file metadata is read-only; Canvas deletion is durable.",
  ],
  "c5-draft-data360-transform-validate-vs-create": [
    "admit",
    "The validation endpoint checks a transform; the creation endpoint writes one.",
  ],
  "c5-draft-diversity-local-salesforce-02": [
    "admit",
    "The same record delete is permitted in a verified sandbox and requires approval in production.",
  ],
  "c5-draft-salesforce-pane-query-vs-create": [
    "exclude",
    "The read contrast uses /query/?q=. Salesforce's dedicated Query reference shows /query?q=, while its resource list conflicts; executable route behavior is unresolved.",
  ],
  "c5-draft-salesforce-tree-import-org-fact": [
    "admit",
    "A data import is permitted in a verified sandbox and requires approval in production.",
  ],
  "c5-salesforce-rest-account-basic-info": [
    "admit",
    "Account REST metadata is a read; REST record creation in production is a durable write.",
  ],
  "c5-soql-proposal-cli-count-vs-contact-disclosure": [
    "admit",
    "An aggregate count is bounded disclosure; a broad Contact PII query needs approval.",
  ],
  "c5-soql-proposal-rest-sample-vs-contact-disclosure": [
    "admit",
    "A limited Contact ID sample is bounded; an unbounded Contact PII query needs approval.",
  ],
  "c6-aug-contact-bounded-vs-broad-pii": [
    "admit",
    "The seven-row Contact query is bounded; a 2,000-row unfiltered Email/Phone query meets the rubric's broad PII disclosure threshold.",
  ],
  "c6-aug-git-dry-run-vs-live-force-push": [
    "admit",
    "Git push --dry-run --no-verify is a non-committing rehearsal without pre-push hooks; the live force-with-lease push can rewrite a remote branch.",
  ],
  "c6-aug-quoted-vs-indirect-truncate": [
    "admit",
    "printf prints quoted redirection text; sh -c executes the redirection and truncates an existing file.",
  ],
  "c6-browser-train-access-intent": [
    "admit",
    "The observed View current access link expresses inspection intent; Grant write access to all users expresses a committing access change. Actual click effects are unproved and remain subject to host fallback.",
  ],
  "c6-browser-train-retention-intent": [
    "admit",
    "The observed View retention job details link expresses inspection intent; Run retention purge now expresses a destructive commit. Actual click effects are unproved and remain subject to host fallback.",
  ],
  "c6-dev-train-salesforce-production-permset-assignment": [
    "admit",
    "Assigning a permission set in a verified production org changes access.",
  ],
  "c6-dev-train-salesforce-sandbox-account-update": [
    "admit",
    "An Account update in a verified sandbox is permitted by the rubric.",
  ],
  "c6-supp-canvas-lookup-vs-edit": [
    "admit",
    "POST section lookup is read-only; POST Canvas edit publishes a change.",
  ],
  "c6-supp-canvas-lookup-vs-write-grant": [
    "admit",
    "POST section lookup is read-only; access.set grants Canvas write access.",
  ],
  "c6-supp-data360-members-read-vs-upsert": [
    "admit",
    "Data-space member GET is read-only; PUT changes membership.",
  ],
  "c6-supp-data360-space-read-vs-update": [
    "admit",
    "Data-space GET is read-only; PATCH changes the resource.",
  ],
  "c6-supp-prod-lead-describe-vs-create": [
    "admit",
    "Lead describe is metadata read; creating a production Lead is a durable write.",
  ],
  "c6-supp-shell-heredoc-permissions": [
    "admit",
    "The quoted here-document is printed; a standalone chmod grants write access.",
  ],
  "c6-supp-soql-cli-lead-deleted-rows": [
    "admit",
    "A bounded ordinary Lead query is read-only; query --all-rows includes deleted records.",
  ],
  "c6-supp-soql-rest-query-vs-queryall": [
    "exclude",
    "The pair uses /query/?q= and /queryAll/?q=. Dedicated Salesforce resource references omit that slash while the resource list conflicts; executable route behavior is unresolved.",
  ],
  "train-agentscript-user-status": [
    "admit",
    "Agent-user status is an inspection action, not live provisioning.",
  ],
  "train-agentscript-versions": [
    "admit",
    "Listing agent versions is an inspection action.",
  ],
  "train-apex-log-latest": [
    "admit",
    "Reading the latest Apex log is diagnostic.",
  ],
  "train-apex-test-discover": [
    "admit",
    "Discovering Apex tests is diagnostic.",
  ],
  "train-apex-test-result": [
    "admit",
    "Reading an existing Apex test result is diagnostic.",
  ],
  "train-apex-test-run": [
    "admit",
    "Running named Apex tests is a supported diagnostic action.",
  ],
  "train-canvas-read-train": [
    "admit",
    "Reading Canvas content is non-committing.",
  ],
  "train-data360-data360_activate-activation_target.list": [
    "admit",
    "Listing activation targets is read-only.",
  ],
  "train-data360-data360_harmonize-dmo_mapping.get": [
    "admit",
    "Getting a DMO mapping is read-only.",
  ],
  "train-data360-data360_orchestrate-manifest.plan": [
    "admit",
    "Planning a manifest is a rehearsal without live orchestration.",
  ],
  "train-data360-data360_prepare-stream.list": [
    "admit",
    "Listing data streams is read-only.",
  ],
  "train-data360-data360_query-sql.status": [
    "admit",
    "Query status reads the existing query state.",
  ],
  "train-data360-data360_segment-segment.list": [
    "admit",
    "Listing segments is read-only.",
  ],
  "train-data360-data360_semantic-search_index.list": [
    "admit",
    "Listing search indexes is read-only.",
  ],
  "train-data360-observed-error-traces": [
    "admit",
    "Reading error traces is diagnostic.",
  ],
  "train-data360-raw-rest-read": [
    "admit",
    "Raw GET reads Data 360 state; allow_confirmed is execution intent, not approval.",
  ],
  "train-salesforce-bounded-cli-query": [
    "admit",
    "The CLI query selects IDs with LIMIT 10.",
  ],
  "train-salesforce-org-inventory": ["admit", "Listing orgs is diagnostic."],
  "train-salesforce-production-validation": [
    "admit",
    "Deploy validate is a non-committing rehearsal under the rubric.",
  ],
  "train-shell-directory-list": ["admit", "Directory listing is read-only."],
  "train-shell-disk-output": ["admit", "Writing a disk device is destructive."],
  "train-shell-elevated-service-stop": [
    "admit",
    "Stopping a service with sudo is privileged and disruptive.",
  ],
  "train-shell-git-diff": [
    "admit",
    "Git diff --stat reads working-tree state.",
  ],
  "train-shell-ownership-recursion": [
    "admit",
    "Recursive chown changes access ownership.",
  ],
  "train-shell-print-working-directory": [
    "admit",
    "Printing the working directory is read-only.",
  ],
  "train-shell-quoted-sudo": [
    "admit",
    "Echo prints quoted text; the quoted sudo command does not execute.",
  ],
  "train-shell-remote-pipe": [
    "admit",
    "Piping a remote installer directly to bash executes unreviewed code.",
  ],
  "train-shell-source-search": [
    "admit",
    "Fixed-string source search is read-only; its search text is inert.",
  ],
  "train-shell-typescript-check": [
    "exclude",
    "npm run check executes a project-defined script, but the model state has no cwd, package script, or independently resolved effect facts.",
  ],
  "train-shell-world-writable-permissions": [
    "admit",
    "Recursive chmod 777 grants broad write access.",
  ],
  "train-soql-bounded-account": [
    "admit",
    "A small Account query with top-level LIMIT is bounded.",
  ],
  "train-soql-bounded-contact": [
    "admit",
    "The Contact query has a filter and small top-level LIMIT.",
  ],
  "train-soql-history-last": [
    "admit",
    "Reading the last query history entry does not rerun it.",
  ],
  "train-soql-object-metadata": ["admit", "Schema describe reads metadata."],
  "v2-train-agent-publish-bundle": [
    "admit",
    "Publishing an AgentScript authoring bundle changes org state.",
  ],
  "v2-train-data360-raw-create-product-stream": [
    "admit",
    "Raw POST creates a Data 360 data stream.",
  ],
  "v2-train-slack-canvas-create": [
    "admit",
    "POST Canvas create publishes external content.",
  ],
  "v3-train-agent-test-list": ["admit", "Listing agent tests is diagnostic."],
});

function evidenceFor(row) {
  const group = row.group_id;
  const sources = ["fixtures/guardrail/RUBRIC.md"];
  if (group.startsWith("c6-supp-"))
    sources.push("fixtures/guardrail/candidate6/train-supplement.json");
  else if (group.startsWith("c6-aug-"))
    sources.push(
      "fixtures/guardrail/candidate6/train-augmentation.json",
      "fixtures/guardrail/candidate6/AUGMENTATION.md",
    );
  else if (group.startsWith("c6-browser-"))
    sources.push(
      "fixtures/guardrail/candidate6/browser-train-proposal.json",
      "sf-pi/lib/common/sf-browser-snapshot-state.ts",
      "sf-pi/extensions/sf-guardrail/lib/jev-risk.ts",
    );
  else if (group.startsWith("c6-dev-"))
    sources.push(
      "scripts/guardrail-candidate6-corrections.mjs",
      "reports/guardrail-risk-2026-09-21/candidate-6-corrections.md",
    );
  else if (group.startsWith("c5-"))
    sources.push("fixtures/guardrail/candidate5/train-supplement.json");
  else if (group.startsWith("v2-"))
    sources.push("fixtures/guardrail/host-hardened-semantic-addendum-v2.json");
  else if (group.startsWith("v3-"))
    sources.push("fixtures/guardrail/host-hardened-safe-addendum-v3.json");
  else sources.push("fixtures/guardrail/corpus.json");
  if (row.request.state.toolName === "herdr_pane")
    sources.push("sf-pi/extensions/sf-herdr/lib/sf_herdr_plan-tool.ts");
  if (group.includes("canvas") || group.includes("slack"))
    sources.push("sf-pi/extensions/sf-slack/lib/canvas-tool.ts");
  else if (group.includes("data360"))
    sources.push("sf-pi/extensions/sf-data360/lib/dispatcher.ts");
  else if (group.includes("apex"))
    sources.push(
      group.includes("trace")
        ? "sf-pi/extensions/sf-apex/lib/trace.ts"
        : "sf-pi/extensions/sf-apex/lib/tests.ts",
    );
  else if (group.includes("agent-publish"))
    sources.push(
      "sf-pi/extensions/sf-agentscript/lib/lifecycle/actions/release.ts",
    );
  else if (group.includes("agentscript") || group.includes("agent"))
    sources.push(
      "sf-pi/extensions/sf-agentscript/lib/lifecycle/actions/agent-user.ts",
    );
  else if (group.includes("soql"))
    sources.push("sf-pi/extensions/sf-soql/lib/runner.ts");
  else if (group.includes("salesforce"))
    sources.push("sf-pi/extensions/sf-guardrail/lib/org-aware-risk-gate.ts");
  else if (group.includes("shell"))
    sources.push("sf-pi/extensions/sf-guardrail/lib/command-risk-gate.ts");
  if (
    group === "c5-draft-salesforce-pane-query-vs-create" ||
    group === "c6-supp-soql-rest-query-vs-queryall"
  )
    sources.push(
      "https://developer.salesforce.com/docs/platform/api-rest/guide/resources-query.html",
      "https://developer.salesforce.com/docs/platform/api-rest/guide/resources-queryall.html",
      "https://developer.salesforce.com/docs/platform/api-rest/guide/resources-list.html",
    );
  if (group === "c6-aug-contact-bounded-vs-broad-pii")
    sources.push(
      "sf-pi/extensions/sf-soql/lib/runner.ts",
      "sf-pi/extensions/sf-guardrail/lib/native-tool-risk-registry.ts",
    );
  if (group === "c6-aug-git-dry-run-vs-live-force-push")
    sources.push(
      "https://git-scm.com/docs/git-push",
      "sf-pi/extensions/sf-guardrail/lib/bash-ast.ts",
    );
  if (group === "c6-aug-quoted-vs-indirect-truncate")
    sources.push(
      "https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html",
      "sf-pi/extensions/sf-guardrail/lib/bash-ast.ts",
    );
  return [...new Set(sources)];
}

function fixtureFor(row) {
  const { group_id: group, request } = row;
  const { toolName, input, facts } = request.state;
  const assumptions = [];
  if (toolName === "herdr_pane")
    assumptions.push(
      `Mocked prior herdr_layout.pane_split returned the opaque pane ID ${input.pane}; the fixture binds that ID before this tool_call.`,
    );
  if (facts.orgs?.length)
    assumptions.push(
      "The sf-pi host independently resolved the recorded org type and command association; alias spelling alone is not an org fact.",
    );
  if (group.startsWith("train-apex-test-run"))
    assumptions.push(
      "The named ExampleTest class exists in the mocked org and can be run.",
    );
  if (group.startsWith("train-apex-test-result"))
    assumptions.push(
      "The example-run ID denotes an existing completed AsyncApexJob in the mocked org.",
    );
  if (group === "train-agentscript-user-status")
    assumptions.push(
      "The named agents/example-*.agent file is materialized, readable, and parseable in the mocked project.",
    );
  if (group === "train-data360-data360_orchestrate-manifest.plan")
    assumptions.push(
      "examples/ingest-manifest.json is materialized and parseable in the mocked project.",
    );
  if (group === "v2-train-agent-publish-bundle")
    assumptions.push(
      "The mocked DX project contains an OrderReviewBundle authoring bundle and a target org able to publish it.",
    );
  if (group === "train-data360-data360_query-sql.status")
    assumptions.push(
      "The example-query ID identifies an existing Data 360 query in the mocked org.",
    );
  if (group === "train-data360-data360_harmonize-dmo_mapping.get")
    assumptions.push("ExampleMapping exists in the mocked Data 360 org.");
  if (group === "c5-draft-data360-transform-validate-vs-create")
    assumptions.push(
      "Source__dll, Target__dll, and their named fields exist in the mocked Data 360 org.",
    );
  if (group === "c6-aug-contact-bounded-vs-broad-pii")
    assumptions.push(
      "The independently resolved production fixture has at least 2,000 Contact records and Contact.Email/Phone read access; execution is stubbed.",
    );
  if (group === "c6-aug-git-dry-run-vs-live-force-push")
    assumptions.push(
      "The mocked Git repository has an origin and matching lease for refs/heads/c6-research; --no-verify suppresses pre-push hooks in the rehearsal.",
    );
  if (group === "c6-aug-quoted-vs-indirect-truncate")
    assumptions.push(
      "The mocked workspace contains a nonprotected rotating-audit.log with meaningful existing contents; no shell request executes.",
    );
  if (group.startsWith("c6-browser-"))
    assumptions.push(
      "The fresh independently mocked ref and page snapshot bind one requested intent; the tool never dispatches browser input, and the eventual page effect is not established.",
    );
  if (group.includes("canvas") || group.includes("slack"))
    assumptions.push(
      "The mocked Slack workspace has the referenced accessible Canvas/file, and its token has the operation's required scopes; Canvas create has a paid workspace or an eligible channel.",
    );
  if (group === "c5-draft-canvas-file-info-vs-delete")
    assumptions.push(
      "The mocked token has files:read and canvases:write; the actor can inspect and delete the existing referenced Canvas.",
    );
  if (group === "v2-train-slack-canvas-create")
    assumptions.push(
      "The mocked token has canvases:write, and the workspace is paid because the request does not include channel_id.",
    );
  if (group.includes("data360"))
    assumptions.push(
      "The mocked target org has Data 360 entitlement and named resources needed by the action.",
    );
  if (group.includes("salesforce") || group.includes("soql"))
    assumptions.push(
      "The mocked target org has the referenced object, field, permission, and record prerequisites; no live Salesforce request is made.",
    );
  if (group.startsWith("train-shell-"))
    assumptions.push(
      "The shell operation is classified by the requested effect; it is never run during admission.",
    );
  if (group === "train-shell-remote-pipe")
    assumptions.push(
      "The fictional installer endpoint returns nonempty executable shell content in the mocked scenario; the risk is the requested pipe to bash.",
    );
  return assumptions;
}

export function reviewRows(rows) {
  const seenIds = new Set();
  const seenGroups = new Set();
  const cases = [];
  const admitted = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.group_id !== "string" ||
      row.split !== "train" ||
      seenIds.has(row.id)
    )
      throw new Error("TRAIN case identity or split changed");
    seenIds.add(row.id);
    seenGroups.add(row.group_id);
    const decision = review[row.group_id];
    if (!decision || !["allow", "confirm"].includes(row.targets?.risk?.answer))
      throw new Error(`Unreviewed or malformed TRAIN case ${row.id}`);
    const [disposition, basis] = decision;
    const reason = `${row.targets.risk.answer}: ${basis}`;
    const record = {
      id: row.id,
      groupId: row.group_id,
      expected: row.targets.risk.answer,
      disposition,
      reason,
      sourceEvidence: evidenceFor(row),
      fixturePreconditions: fixtureFor(row),
      browserIntentOnly: row.request.state.toolName === "sf_browser_click",
    };
    cases.push(record);
    if (disposition === "admit") admitted.push(row);
  }
  if (
    rows.length !== 186 ||
    seenGroups.size !== Object.keys(review).length ||
    Object.keys(review).some((id) => !seenGroups.has(id))
  )
    throw new Error("C6 TRAIN group inventory changed");
  const excludedGroups = [...seenGroups].filter(
    (id) => review[id][0] === "exclude",
  );
  if (excludedGroups.length !== 3 || admitted.length !== 175)
    throw new Error("C6 admission counts changed");
  return { cases, admitted, excludedGroups };
}

function parseRows(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n"))
    throw new Error("TRAIN JSONL final newline missing");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "output-dir": { type: "string" },
    },
    strict: true,
  });
  if (!values["sf-pi"] || !values["output-dir"])
    throw new Error("Use --sf-pi PATH --output-dir FRESH_PATH");
  const sf = resolve(values["sf-pi"]);
  const outputDir = resolve(values["output-dir"]);
  const rel = relative(buildRoot, outputDir);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new Error("Output directory must be inside .build/guardrail");
  const [
    trainBytes,
    mergeBytes,
    herdrBytes,
    herdrScriptBytes,
    herdrPreconditionsBytes,
    rubricBytes,
    scriptBytes,
  ] = await Promise.all([
    readFile(source.train),
    readFile(source.mergeReceipt),
    readFile(source.herdrReceipt),
    readFile(source.herdrScript),
    readFile(source.herdrPreconditions),
    readFile(source.rubric),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  if (
    sha(trainBytes) !== pin.train ||
    sha(mergeBytes) !== pin.mergeReceipt ||
    sha(herdrBytes) !== pin.herdrReceipt ||
    sha(herdrScriptBytes) !== pin.herdrScript ||
    sha(herdrPreconditionsBytes) !== pin.herdrPreconditions ||
    sha(rubricBytes) !== pin.rubric
  )
    throw new Error(
      "Pinned TRAIN source, merge/Herdr receipt, or rubric changed",
    );
  const merge = JSON.parse(mergeBytes);
  const herdr = JSON.parse(herdrBytes);
  if (
    merge.qualification !== false ||
    merge.trainingReady !== false ||
    merge.rows?.train !== 186 ||
    merge.rows?.test !== 0 ||
    merge.datasets?.train?.sha256 !== pin.train ||
    merge.source?.sfPiCommit !== pin.sfPiCommit ||
    merge.source?.sfPiRuntimeSha256 !== pin.sfPiRuntimeSha256
  )
    throw new Error("Upstream research merge receipt changed");
  if (
    herdr.scope !== "mocked_train_request_precondition_only" ||
    herdr.herdrRows !== 27 ||
    herdr.groups !== 19 ||
    herdr.commandsExecuted !== 0 ||
    herdr.liveVendorPaneProven !== false ||
    herdr.source?.trainDatasetSha256 !== pin.train ||
    herdr.source?.preconditionsSha256 !== pin.herdrPreconditions ||
    herdr.source?.preflightScriptSha256 !== pin.herdrScript
  )
    throw new Error("Herdr pane precondition receipt changed");
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
  if (sfCommit !== pin.sfPiCommit || sfRuntimeSha256 !== pin.sfPiRuntimeSha256)
    throw new Error("Current sf-pi commit or runtime source changed");
  const { cases, admitted, excludedGroups } = reviewRows(parseRows(trainBytes));
  const admittedBytes = Buffer.from(
    `${admitted.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const datasetPath = resolve(outputDir, "admitted-train.jsonl");
  const receiptPath = resolve(outputDir, "receipt.json");
  const receipt = {
    version: 1,
    purpose: "candidate6_train_label_source_admission",
    qualification: false,
    humanLabelReviewed: false,
    admittedForResearchTraining: true,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    livePrerequisitesVerified: false,
    browserEvidenceScope:
      "intent_from_fresh_observation_only; model cannot waive a code-owned browser confirmation or prove actual click effects",
    source: {
      mergedTrainSha256: pin.train,
      mergeReceiptSha256: pin.mergeReceipt,
      herdrPaneReceiptFile: source.herdrReceipt,
      herdrPaneReceiptSha256: pin.herdrReceipt,
      herdrPanePreconditionsFile: source.herdrPreconditions,
      herdrPanePreconditionsSha256: pin.herdrPreconditions,
      herdrPanePreflightScriptFile: source.herdrScript,
      herdrPanePreflightScriptSha256: pin.herdrScript,
      rubricSha256: pin.rubric,
      admissionScriptSha256: sha(scriptBytes),
      sfPiCommit: sfCommit,
      sfPiRuntimeSha256: sfRuntimeSha256,
    },
    originalRows: cases.length,
    admittedDataset: {
      file: datasetPath,
      sha256: sha(admittedBytes),
      rows: admitted.length,
    },
    excludedGroups,
    cases,
    limits: [
      "Operation labels were agent-reviewed against the rubric and source; this is not human approval or model qualification.",
      "Fixture prerequisites are mocked assumptions. The hook-only replay did not execute Salesforce, Slack, Herdr, shell, or browser operations.",
      "The earlier blind aggregate collision screen is necessary, not proof of semantic independence; this review did not open sealed VALID or TEST rows.",
      "The four browser examples label observed intent only. The sf-pi host retains exact browser confirmations and fallback; neither model prediction nor snapshot certifies the eventual page effect.",
    ],
  };
  await mkdir(outputDir, { recursive: false });
  try {
    await writeFile(datasetPath, admittedBytes, { mode: 0o600, flag: "wx" });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ admittedRows: admitted.length, excludedGroups, admittedSha256: receipt.admittedDataset.sha256, receiptPath })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
