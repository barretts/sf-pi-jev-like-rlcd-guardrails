/** Build a TRAIN/VALIDATION-only candidate from the sealed host export.
 *
 * This reads reserved requests solely to reject exact, canonical and coarse
 * operation replay. It never reads reserved labels, prints reserved examples,
 * invokes a model, or executes any authored tool request.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(
  root,
  "fixtures/guardrail/candidate5/train-supplement.json",
);
const treePath = resolve(
  root,
  "fixtures/guardrail/candidate5/accounts-tree.json",
);
const policyPath = resolve(root, "fixtures/guardrail/candidate5/POLICY.md");
const expectedCorpusSha256 =
  "bb4ed147933c076111b127e6a5433c6ce7ea54cc43befb7d384ddb54681e6309";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const load = async (path) => {
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes), sha256: sha(bytes) };
};
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, sorted(entry)]),
        )
      : value;
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : typeof value === "string"
        ? value.trim().replace(/\s+/g, " ")
        : value;
const signature = (value) => ({
  exact: sha(JSON.stringify(sorted(value))),
  canonical: sha(JSON.stringify(canonical(value))),
});

function commandTemplate(command) {
  const clean = command
    .replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "")
    .trim();
  const slack = clean.match(/https:\/\/slack\.com\/api\/([\w.]+)/i);
  if (slack) {
    const method = /(?:\s--get\b|\s-X\s+GET\b|\s--request\s+GET\b)/i.test(clean)
      ? "GET"
      : /(?:\s-X\s+POST\b|\s--request\s+POST\b|\s--data(?:-binary|-urlencode)?\b)/i.test(
            clean,
          )
        ? "POST"
        : "GET";
    return `slack|${method}|${slack[1].toLowerCase()}`;
  }
  const rest = clean.match(/\bsf\s+api\s+request\s+rest\s+['"]?([^'"\s]+)/i);
  if (rest) {
    const method =
      clean
        .match(/--method\s+(GET|POST|PUT|PATCH|DELETE|HEAD)/i)?.[1]
        ?.toUpperCase() ?? "GET";
    const path = rest[1]
      .split("?")[0]
      .replace(/^\//, "")
      .replace(/\/v\d+\.\d+\//i, "/v:version/")
      .replace(/\/\w{15}(?:\w{3})?(?=\/|$)/g, "/:id")
      .toLowerCase();
    return `sf-api-rest|${method}|${path}`;
  }
  const sf = clean.match(/\bsf\s+([^;&|]+)/i);
  if (sf) {
    const words = [];
    for (const word of sf[1].trim().split(/\s+/)) {
      if (word.startsWith("-")) break;
      words.push(word);
    }
    return `sf|${words
      .slice(0, words[0] === "force" ? 4 : 3)
      .join(" ")
      .toLowerCase()}`;
  }
  if (/\|\s*(?:bash|sh)\b/i.test(clean)) return "shell|pipeline-to-interpreter";
  if (/^bash\s+-c\b/i.test(clean)) return "shell|bash-c";
  if (/^python3?\s+-c\b/i.test(clean)) return "shell|python-c";
  if (/^bash\s*<</i.test(clean)) return "shell|bash-heredoc";
  const first = clean.match(/^([A-Za-z0-9_.\/-]+)(?:\s+([^\s]+))?/);
  return first ? `shell|${first[1]}|${first[2] ?? ""}` : undefined;
}

function operationTemplate(value) {
  const { toolName, input } = value;
  if (typeof input?.command === "string") return commandTemplate(input.command);
  if (toolName === "data360_api" && input?.action === "rest.request")
    return `data360_api|${String(input.params?.method ?? "").toUpperCase()}|${String(
      input.params?.path ?? "",
    )
      .split("?")[0]
      .toLowerCase()}`;
  if (toolName === "sf_soql")
    return `sf_soql|${String(input?.action ?? "").toLowerCase()}`;
  if (toolName === "sf_browser_press") {
    const parts = String(input?.key ?? "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/^cmd\+|^command\+/, "meta+")
      .replace(/^control\+/, "ctrl+")
      .replace(/\+option\+/, "+alt+")
      .split("+");
    const last = parts.pop();
    if (!last) return undefined;
    const mods = new Set(
      parts.map((part) =>
        part === "control" || part === "ctrl"
          ? "meta"
          : part === "option"
            ? "alt"
            : part,
      ),
    );
    const key = ["up", "down", "arrowup", "arrowdown"].includes(last)
      ? "vertical-arrow-navigation"
      : last;
    return `sf_browser_press|${[...["meta", "alt", "shift"].filter((part) => mods.has(part)), key].join("+")}`;
  }
  return typeof input?.action === "string"
    ? `${toolName}|${input.action.toLowerCase()}`
    : undefined;
}

function relatedOperation(value) {
  const key = operationTemplate(value);
  if (key === "sf_browser_press|meta+/") return "browser-help";
  if (key === "sf_browser_press|meta+shift+s") return "browser-create-version";
  if (value.toolName === "sf_browser_click") {
    const label =
      value.observations?.browser?.label ?? value.facts?.browserRef?.label;
    if (typeof label === "string") {
      if (/\b(?:new version|save as)\b/i.test(label))
        return "browser-create-version";
      if (/\b(?:keyboard shortcuts|shortcut help)\b/i.test(label))
        return "browser-help";
    }
  }
  if (
    value.toolName === "sf_apex" &&
    /^trace\./.test(String(value.input?.action ?? ""))
  )
    return "apex-trace-lifecycle";
  if (
    typeof value.input?.command === "string" &&
    /\bsf\s+apex\s+(?:tail\s+log|log\s+tail)\b|\b(?:TraceFlag|DebugLevel)\b/i.test(
      value.input.command,
    )
  )
    return "apex-trace-lifecycle";
  return undefined;
}

const emptyBucket = () => ({
  exact: new Set(),
  canonical: new Set(),
  template: new Set(),
  related: new Set(),
  id: new Set(),
  group: new Set(),
});
function add(bucket, value, id, group) {
  if (value) {
    const sig = signature(value);
    bucket.exact.add(sig.exact);
    bucket.canonical.add(sig.canonical);
    const template = operationTemplate(value);
    if (template) bucket.template.add(template);
    const operation = relatedOperation(value);
    if (operation) bucket.related.add(operation);
  }
  bucket.id.add(id);
  bucket.group.add(group);
}
function collision(bucket, value, id, group) {
  const sig = signature(value);
  const template = operationTemplate(value);
  const operation = relatedOperation(value);
  return (
    bucket.id.has(id) ||
    bucket.group.has(group) ||
    bucket.exact.has(sig.exact) ||
    bucket.canonical.has(sig.canonical) ||
    Boolean(template && bucket.template.has(template)) ||
    Boolean(operation && bucket.related.has(operation))
  );
}

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    baseline: { type: "string" },
    "baseline-sha256": { type: "string" },
    "sf-pi": { type: "string" },
    output: { type: "string" },
    receipt: { type: "string" },
  },
});
if (
  Object.values(values).some((value) => !value) ||
  Object.keys(values).length !== 6
)
  throw new Error(
    "Required: --corpus FILE --baseline FILE --baseline-sha256 SHA256 --sf-pi DIR --output FILE --receipt FILE",
  );
const sf = resolve(values["sf-pi"]);
const [corpus, baseline, supplement, treeBytes, policyBytes] =
  await Promise.all([
    load(resolve(values.corpus)),
    load(resolve(values.baseline)),
    load(fixturePath),
    readFile(treePath),
    readFile(policyPath),
  ]);
if (baseline.sha256 !== values["baseline-sha256"])
  throw new Error("Pinned SF baseline checksum mismatch");
if (
  corpus.sha256 !== expectedCorpusSha256 ||
  supplement.value.baseCorpusSha256 !== corpus.sha256 ||
  baseline.value.corpusSha256 !== corpus.sha256
)
  throw new Error("Sealed corpus identity changed");
const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sf,
  encoding: "utf8",
}).trim();
if (
  sfCommit !== supplement.value.sfPiCommit ||
  sfCommit !== baseline.value.sfPiCommit
)
  throw new Error("Supplement, baseline, and SF host commits differ");
if (
  supplement.value.version !== 1 ||
  !Array.isArray(supplement.value.cases) ||
  !Array.isArray(corpus.value.cases) ||
  !Array.isArray(baseline.value.records)
)
  throw new Error("Invalid source shape");

const temp = await mkdtemp(resolve(tmpdir(), "c5-guardrail-facts-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = temp;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    {
      buildJevRiskInput,
      jevRiskEligible,
      jevRiskPolicyFloor,
      prepareJevRiskInput,
    },
    { restoreFromSessionEntries, clearSharedSfEnvironment },
    { writeLatestBrowserSnapshotRefs },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("lib/common/sf-browser-snapshot-state.ts"),
  ]);
  const corpusById = new Map(corpus.value.cases.map((row) => [row.id, row]));
  const reserved = emptyBucket();
  const reservedRaw = emptyBucket();
  for (const row of corpus.value.cases) {
    if (row.split === "train") continue;
    // Reserved expected outcome, rubric, baseline and prediction are not read.
    add(
      reservedRaw,
      {
        toolName: row.toolName,
        input: row.input,
        observations: row.observations ?? {},
      },
      row.id,
      row.groupId,
    );
  }
  for (const row of baseline.value.records) {
    if (row.split === "train") continue;
    if (row.riskInput) add(reserved, row.riskInput, row.id, row.groupId);
  }
  const candidateGroups = new Map();
  const held = [];
  const addGroup = (origin, row) => {
    const key = `${origin}|${row.groupId}`;
    const group = candidateGroups.get(key) ?? {
      origin,
      id: row.groupId,
      rows: [],
    };
    group.rows.push(row);
    candidateGroups.set(key, group);
  };
  for (const row of baseline.value.records)
    if (row.split === "train" && row.modelEligible) {
      if (!row.riskInput || row.riskInput.version !== 2)
        throw new Error("Eligible host TRAIN input is not v2");
      addGroup("sealed_host_train", { ...row, raw: corpusById.get(row.id) });
    }
  const seenSupplementIds = new Set();
  for (const authored of supplement.value.cases) {
    if (
      authored.split !== "train" ||
      !["allow", "confirm"].includes(authored.expected) ||
      !Array.isArray(authored.sourceEvidence) ||
      !authored.sourceEvidence.length ||
      seenSupplementIds.has(authored.id)
    )
      throw new Error(`Invalid TRAIN supplement row ${authored.id}`);
    seenSupplementIds.add(authored.id);
    const row = structuredClone(authored);
    if (typeof row.input.command === "string")
      row.input.command = row.input.command.replaceAll(
        "__C5_TREE_FIXTURE__",
        treePath,
      );
    const cwd = "/example/project";
    clearSharedSfEnvironment(cwd);
    const org = row.observations?.org;
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
    const sessionId = `c5-bundle-${row.id}`;
    const page = row.observations?.browserPage;
    if (page) {
      if (
        page.status !== "fresh" ||
        typeof page.snapshot !== "string" ||
        !page.snapshot.trim()
      )
        throw new Error("Browser page fixture is not fresh");
      writeLatestBrowserSnapshotRefs({
        sessionId,
        snapshot: page.snapshot,
        url: page.url,
      });
    }
    const input = {
      toolName: row.toolName,
      input: row.input,
      cwd,
      sessionId,
      config: readBundledConfig(),
    };
    const existing = await evaluateSafety(input);
    const policyFloor = jevRiskPolicyFloor(input, existing);
    if (!jevRiskEligible(input) || policyFloor)
      throw new Error(`Supplement no longer reaches semantic model: ${row.id}`);
    const riskInput = await prepareJevRiskInput(input, existing);
    if (
      riskInput.version !== 2 ||
      riskInput.toolName !== row.toolName ||
      JSON.stringify(riskInput.input) !== JSON.stringify(row.input)
    )
      throw new Error(`Host risk input changed: ${row.id}`);
    if (page) {
      const url = new URL(page.url);
      if (
        riskInput.facts.browserPage?.url !== `${url.origin}${url.pathname}` ||
        riskInput.facts.browserPage.snapshotSha256 !== sha(page.snapshot)
      )
        throw new Error(`Browser page fact mismatch: ${row.id}`);
    }
    if (
      org &&
      !riskInput.facts.orgs?.some(
        (fact) => fact.type === org.type && fact.guessed === false,
      )
    )
      throw new Error(`Verified org fact mismatch: ${row.id}`);
    addGroup("authored_supplement", { ...row, riskInput, raw: row });
  }
  const selected = [];
  const selectedIds = new Set();
  const selectedCanonical = new Map();
  const selectedGroups = new Set();
  let deduplicated = 0;
  for (const group of candidateGroups.values()) {
    let reject = false;
    for (const row of group.rows) {
      const raw = {
        toolName: row.raw.toolName,
        input: row.raw.input,
        observations: row.raw.observations ?? {},
      };
      if (
        collision(reserved, row.riskInput, row.id, group.id) ||
        collision(reservedRaw, raw, row.id, group.id)
      )
        reject = true;
    }
    if (reject) {
      held.push({
        origin: group.origin,
        reason: "strict_reserved_exact_canonical_template_or_group",
      });
      continue;
    }
    if (selectedGroups.has(group.id)) throw new Error("TRAIN group ID reused");
    selectedGroups.add(group.id);
    for (const row of group.rows) {
      if (selectedIds.has(row.id)) throw new Error("TRAIN case ID reused");
      selectedIds.add(row.id);
      const key = signature(row.riskInput).canonical;
      const previous = selectedCanonical.get(key);
      if (previous && previous !== row.expected)
        throw new Error("Conflicting TRAIN labels for identical model input");
      if (previous) {
        deduplicated++;
        continue;
      }
      selectedCanonical.set(key, row.expected);
      selected.push({
        id: row.id,
        groupId: group.id,
        family: row.family,
        split: "train",
        expected: row.expected,
        modelEligible: true,
        riskInput: row.riskInput,
      });
    }
  }
  const validation = baseline.value.records
    .filter((row) => row.split === "validation" && row.modelEligible)
    .map((row) => {
      if (!row.riskInput || row.riskInput.version !== 2)
        throw new Error("Eligible host VALID input is not v2");
      return {
        id: row.id,
        groupId: row.groupId,
        family: row.family,
        split: "validation",
        expected: row.expected,
        modelEligible: true,
        riskInput: row.riskInput,
      };
    });
  if (
    !selected.length ||
    !validation.length ||
    selected.some(
      (row) =>
        reserved.group.has(row.groupId) || reservedRaw.group.has(row.groupId),
    )
  )
    throw new Error("TRAIN/VALIDATION split invalid");
  const byFamily = {};
  for (const row of selected) {
    byFamily[row.family] ??= { allow: 0, confirm: 0 };
    byFamily[row.family][row.expected]++;
  }
  const requiredFamilies = [
    "shell",
    "herdr",
    "salesforce",
    "apex",
    "agentscript",
    "data360",
    "soql",
    "canvas",
    "browser",
  ];
  const coverageGaps = requiredFamilies.filter(
    (family) => !byFamily[family]?.allow || !byFamily[family]?.confirm,
  );
  const source = {
    corpusSha256: corpus.sha256,
    baselineSha256: baseline.sha256,
    baselineSourceSha256: baseline.value.baselineSourceSha256,
    sfPiCommit: sfCommit,
    supplementSha256: supplement.sha256,
    treeFixtureSha256: sha(treeBytes),
    policyInterpretationSha256: sha(policyBytes),
  };
  const bundle = {
    version: 1,
    rubricVersion: "operation-policy-v2",
    corpusSha256: sha(JSON.stringify(source)),
    baselineSourceSha256: baseline.value.baselineSourceSha256,
    sourceSha256: source,
    mockedExecution: true,
    status: coverageGaps.length
      ? "review-only; TRAIN coverage gaps remain"
      : "TRAIN/VALIDATION only; qualification pending",
    records: [...selected, ...validation],
  };
  const bundleBytes = JSON.stringify(bundle, null, 2) + "\n";
  const receipt = {
    version: 1,
    source,
    outputSha256: sha(bundleBytes),
    trainRows: selected.length,
    trainGroups: new Set(selected.map((row) => row.groupId)).size,
    validationRows: validation.length,
    validationGroups: new Set(validation.map((row) => row.groupId)).size,
    testRows: 0,
    supplementRowsAuthored: supplement.value.cases.length,
    supplementRowsAdmitted: selected.filter((row) =>
      seenSupplementIds.has(row.id),
    ).length,
    deduplicatedCanonicalTrainRows: deduplicated,
    heldGroupReasons: held.reduce((acc, item) => {
      const key = `${item.origin}:${item.reason}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    trainFamilyLabels: byFamily,
    coverageGaps,
    trainingReady: coverageGaps.length === 0,
    exactReservedReplay: 0,
    canonicalReservedReplay: 0,
    coarseReservedReplay: 0,
    reservedLabelsRead: false,
    reservedContentEmitted: false,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    review:
      "Machine-authored policy labels and mocked host facts. Live CLI/API acceptance and human label review remain unverified.",
  };
  await writeFile(resolve(values.output), bundleBytes, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(
    resolve(values.receipt),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      trainRows: receipt.trainRows,
      trainGroups: receipt.trainGroups,
      validationRows: receipt.validationRows,
      validationGroups: receipt.validationGroups,
      supplementRowsAdmitted: receipt.supplementRowsAdmitted,
      coverageGaps,
      trainingReady: receipt.trainingReady,
      outputSha256: receipt.outputSha256,
    }),
  );
} finally {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  await rm(temp, { recursive: true, force: true });
}
