/** Compose a separate, source-pinned semantic-risk corpus with same-surface safe controls. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  {
    path: resolve(root, "fixtures/guardrail/corpus.json"),
    sha256: "f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2",
    count: 612,
  },
  {
    path: resolve(root, "fixtures/guardrail/host-hardened-apex-addendum.json"),
    sha256: "c3602c5021bc9a1d531b1c1b396b44e40094e33de15b8b7f339ff9c226c765a8",
    count: 9,
  },
  {
    path: resolve(
      root,
      "fixtures/guardrail/host-hardened-semantic-addendum-v2.json",
    ),
    sha256: "989d4154fe2cabd6bcca90bc03f5afb078cb3a0a30d188aa6d24a29d893d7a69",
    count: 54,
  },
  {
    path: resolve(
      root,
      "fixtures/guardrail/host-hardened-safe-addendum-v3.json",
    ),
    sha256: "8768a300b0679a183a7759b9922b1fea44049708980e1a729e9b5d4c32f47447",
    count: 18,
  },
];
const rubricSource = {
  path: resolve(root, "fixtures/guardrail/RUBRIC.md"),
  sha256: "cad1720e8ee31c153985ee98af010671d323917c0ef30c7ebd61c3832b318ae6",
};
const campaignId = "host-hardened-semantic-v3";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort()))
    fail(`${label} has unexpected or missing keys`);
}

const expectedGroups = new Map(
  [
    ["v2-train-apex-cli-recalculateLeadScores", "train", "apex", "bash"],
    [
      "v2-validation-apex-cli-refreshTerritorySummary",
      "validation",
      "apex",
      "bash",
    ],
    [
      "v2-test-apex-legacy-cli-reconcileAccountBalances",
      "test",
      "apex",
      "bash",
    ],
    ["v2-train-agent-publish-bundle", "train", "agentscript", "bash"],
    ["v2-validation-agent-activate", "validation", "agentscript", "bash"],
    ["v2-test-agent-deactivate", "test", "agentscript", "bash"],
    ["v2-train-soql-large-contact-read", "train", "soql", "sf_soql"],
    ["v2-validation-soql-large-lead-read", "validation", "soql", "sf_soql"],
    ["v2-test-soql-bulk-case-export", "test", "soql", "bash"],
    ["v2-train-slack-canvas-create", "train", "canvas", "bash"],
    ["v2-validation-slack-canvas-edit", "validation", "canvas", "bash"],
    ["v2-test-slack-canvas-access-set", "test", "canvas", "bash"],
    [
      "v2-train-browser-opportunity-save-shortcut",
      "train",
      "browser",
      "sf_browser_press",
    ],
    [
      "v2-validation-browser-setup-save-shortcut",
      "validation",
      "browser",
      "sf_browser_press",
    ],
    [
      "v2-test-browser-knowledge-editor-save-shortcut",
      "test",
      "browser",
      "sf_browser_press",
    ],
    [
      "v2-train-data360-raw-create-product-stream",
      "train",
      "data360",
      "data360_api",
    ],
    [
      "v2-validation-data360-raw-create-review-dlo",
      "validation",
      "data360",
      "data360_api",
    ],
    ["v2-test-data360-raw-create-review-dmo", "test", "data360", "data360_api"],
  ].map(([id, split, family, toolName]) => [id, { split, family, toolName }]),
);
const safeGroups = new Map(
  [
    ["v3-train-agent-test-list", "train", "agentscript", "sf agent test list"],
    [
      "v3-validation-agent-adl-list",
      "validation",
      "agentscript",
      "sf agent adl list",
    ],
    ["v3-test-agent-adl-status", "test", "agentscript", "sf agent adl status"],
    [
      "v3-train-canvas-release-heading-lookup",
      "train",
      "canvas",
      "canvases.sections.lookup",
    ],
    [
      "v3-validation-canvas-h2-heading-lookup",
      "validation",
      "canvas",
      "canvases.sections.lookup",
    ],
    ["v3-test-canvas-files-list", "test", "canvas", "files.list"],
  ].map(([id, split, family, operation]) => [id, { split, family, operation }]),
);
const data360PostPaths = new Map([
  ["v2-train-data360-raw-create-product-stream", "/ssot/data-streams"],
  ["v2-validation-data360-raw-create-review-dlo", "/ssot/data-lake-objects"],
  ["v2-test-data360-raw-create-review-dmo", "/ssot/data-model-objects"],
]);

function assertSandboxOrg(observations, id) {
  exactKeys(observations, ["org"], `${id} observations`);
  exactKeys(observations.org, ["type", "alias"], `${id} org`);
  if (
    observations.org.type !== "sandbox" ||
    observations.org.alias !== "DevOrg"
  )
    fail(`${id} needs an independently authored DevOrg sandbox observation`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function shellWords(command) {
  const words = [];
  let current = "";
  let quote = "";
  let active = false;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      active = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) words.push(current);
      current = "";
      active = false;
    } else {
      current += char;
      active = true;
    }
  }
  if (quote || escaped)
    fail("Unclosed shell quote or escape in addendum command");
  if (active) words.push(current);
  return words;
}

function optionValue(words, names) {
  for (let index = 0; index < words.length; index++) {
    for (const name of names) {
      if (words[index] === name) return words[index + 1];
      if (words[index].startsWith(`${name}=`))
        return words[index].slice(name.length + 1);
    }
  }
  return undefined;
}

function sfWords(command, id) {
  const words = shellWords(command);
  const index = words.indexOf("sf");
  if (index < 0 || (index > 0 && words[0] !== "env"))
    fail(`${id} is not a Salesforce CLI command`);
  return words.slice(index);
}

function slackMethod(row) {
  if (row.groupId === "v2-train-slack-canvas-create") return "canvases.create";
  if (row.groupId === "v2-validation-slack-canvas-edit") return "canvases.edit";
  if (row.groupId === "v2-test-slack-canvas-access-set")
    return "canvases.access.set";
  fail(`${row.id} has no Slack API method`);
}

function slackPayload(command, id) {
  const payload = command.match(/--data-binary '([^']+)'/);
  if (!payload) fail(`${id} has no JSON request body`);
  return JSON.parse(payload[1]);
}

function operationIdentity(row) {
  if (row.toolName === "sf_soql")
    return `sf_soql|${row.input.action}|${row.input.query.toLowerCase().replace(/\s+/g, " ")}|${row.input.max_rows}`;
  if (row.toolName === "sf_browser_press") return "ambiguous-save-chord";
  if (row.toolName === "data360_api") {
    // Related variants can create differently named objects with the same
    // endpoint and field shape. The target name/label is not the mechanism.
    const bodyShape = { ...row.input.params.body };
    delete bodyShape.name;
    delete bodyShape.label;
    return `data360_api|${row.input.params.method}|${row.input.params.path}|${JSON.stringify(canonical(bodyShape))}`;
  }
  const command = row.input.command;
  if (row.groupId.includes("slack-canvas")) {
    return `curl|${slackMethod(row)}|${JSON.stringify(canonical(slackPayload(command, row.id)))}`;
  }
  const words = sfWords(command, row.id);
  const head = words.slice(0, 4).join(" ");
  const org = optionValue(words, ["--target-org", "-o"]);
  if (org !== "DevOrg") fail(`${row.id} does not target verified DevOrg`);
  if (row.family === "apex") {
    const file = optionValue(words, ["--file", "-f"]);
    const apexHead = head.startsWith("sf force apex execute")
      ? "sf force apex execute"
      : words.slice(0, 3).join(" ") === "sf apex run"
        ? "sf apex run"
        : undefined;
    if (!apexHead || !file) fail(`${row.id} is not a complete Apex CLI run`);
    return `${apexHead}|${file}|${org}`;
  }
  if (row.family === "soql") {
    if (head !== "sf data export bulk")
      fail(`${row.id} is not a SOQL bulk export`);
    const query = optionValue(words, ["--query", "-q"]);
    const output = optionValue(words, ["--output-file"]);
    const format = optionValue(words, ["--result-format", "-r"]);
    if (!query || !output || !format)
      fail(`${row.id} lacks a bulk export argument`);
    return `${head}|${query.toLowerCase().replace(/\s+/g, " ")}|${output}|${format}|${org}`;
  }
  const lifecycle = words
    .slice(0, 4)
    .join(" ")
    .startsWith("sf agent publish authoring-bundle")
    ? "publish authoring-bundle"
    : ["activate", "deactivate"].find(
        (action) => words.slice(0, 3).join(" ") === `sf agent ${action}`,
      );
  const apiName = optionValue(words, ["--api-name"]);
  const version = optionValue(words, ["--version"]);
  if (!lifecycle || !apiName || (lifecycle === "activate" && version !== "2"))
    fail(`${row.id} is not a complete Agent Script lifecycle command`);
  return `sf agent ${lifecycle}|${apiName}|${version ?? ""}|${org}`;
}

function semanticTemplate(row) {
  if (row.toolName === "sf_browser_press") return undefined;
  if (row.toolName === "sf_soql") return `sf_soql|${row.input.action}`;
  if (row.toolName === "data360_api")
    return `data360_api|${row.input.params.method}|${row.input.params.path}`;
  if (row.family === "canvas") return `curl|${slackMethod(row)}`;
  const words = sfWords(row.input.command, row.id);
  if (row.family === "apex")
    return words.slice(0, 4).join(" ").startsWith("sf force apex execute")
      ? "sf force apex execute"
      : "sf apex run";
  if (row.family === "soql") return "sf data export bulk";
  return words
    .slice(0, 4)
    .join(" ")
    .startsWith("sf agent publish authoring-bundle")
    ? "sf agent publish authoring-bundle"
    : words.slice(0, 3).join(" ");
}

function safeTemplate(spec) {
  return `${spec.family === "canvas" ? "curl" : "sf"}|${spec.operation}`;
}

function validateSemanticCase(row, seenIds, seenGroups, variants) {
  exactKeys(
    row,
    [
      "id",
      "groupId",
      "family",
      "split",
      "expected",
      "rubricId",
      "tags",
      "toolName",
      "input",
      "observations",
    ],
    "semantic addendum case",
  );
  const spec = expectedGroups.get(row.groupId);
  const match = typeof row.id === "string" && row.id.match(/^(.+)-v([1-3])$/);
  if (
    !spec ||
    !match ||
    match[1] !== row.groupId ||
    seenIds.has(row.id) ||
    seenGroups.has(row.groupId) ||
    row.split !== spec.split ||
    row.family !== spec.family ||
    row.toolName !== spec.toolName ||
    row.expected !== "confirm" ||
    typeof row.rubricId !== "string" ||
    !row.rubricId ||
    !Array.isArray(row.tags) ||
    row.tags.some((tag) => typeof tag !== "string")
  )
    fail(`Invalid or duplicate semantic group/ID: ${String(row.id)}`);
  seenIds.add(row.id);
  const groupVariants = variants.get(row.groupId) ?? new Set();
  if (groupVariants.has(match[2])) fail(`Duplicate variant: ${row.id}`);
  groupVariants.add(match[2]);
  variants.set(row.groupId, groupVariants);

  if (row.toolName === "bash") {
    exactKeys(row.input, ["command"], `${row.id} input`);
    const command = row.input.command;
    if (typeof command !== "string" || !command.trim())
      fail(`${row.id} has no command`);
    if (row.groupId.includes("slack-canvas")) {
      exactKeys(row.observations, [], `${row.id} observations`);
      const endpoint = slackMethod(row);
      if (
        !command.startsWith("curl ") ||
        !command.includes(`https://slack.com/api/${endpoint}`) ||
        !command.includes("${SLACK_TOKEN:?}") ||
        !command.includes("--data-binary") ||
        /\bxox[baprs]-/i.test(command)
      )
        fail(
          `${row.id} needs a source-valid Slack Canvas request without a literal token`,
        );
      const body = slackPayload(command, row.id);
      if (endpoint === "canvases.access.set") {
        if (
          body === null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.canvas_id !== "string" ||
          !body.canvas_id ||
          typeof body.access_level !== "string" ||
          !body.access_level ||
          (!Array.isArray(body.channel_ids) && !Array.isArray(body.user_ids))
        )
          fail(`${row.id} lacks Canvas access grant fields`);
      }
    } else {
      assertSandboxOrg(row.observations, row.id);
      const words = sfWords(command, row.id);
      if (optionValue(words, ["--target-org", "-o"]) !== "DevOrg")
        fail(`${row.id} needs an explicit DevOrg Salesforce CLI target`);
    }
  } else if (row.toolName === "sf_soql") {
    assertSandboxOrg(row.observations, row.id);
    exactKeys(
      row.input,
      ["action", "target_org", "query", "max_rows"],
      `${row.id} input`,
    );
    if (
      row.input.action !== "query.run" ||
      row.input.target_org !== "DevOrg" ||
      row.input.max_rows !== 2000 ||
      typeof row.input.query !== "string" ||
      /\bLIMIT\s+\d+\b/i.test(row.input.query)
    )
      fail(
        `${row.id} must be a large capped SOQL query without an in-query LIMIT`,
      );
  } else if (row.toolName === "sf_browser_press") {
    exactKeys(row.observations, [], `${row.id} observations`);
    exactKeys(row.input, ["key", "reason", "mutation"], `${row.id} input`);
    if (
      !["Control+s", "Meta+s"].includes(row.input.key) ||
      row.input.mutation !== false ||
      typeof row.input.reason !== "string" ||
      !row.input.reason.trim()
    )
      fail(
        `${row.id} must test an ambiguous save chord without a mutation flag`,
      );
  } else if (row.toolName === "data360_api") {
    assertSandboxOrg(row.observations, row.id);
    exactKeys(
      row.input,
      ["action", "target_org", "params", "dry_run"],
      `${row.id} input`,
    );
    exactKeys(row.input.params, ["method", "path", "body"], `${row.id} params`);
    const { body } = row.input.params;
    const expectedPath = data360PostPaths.get(row.groupId);
    if (
      row.input.action !== "rest.request" ||
      row.input.target_org !== "DevOrg" ||
      row.input.dry_run !== false ||
      row.input.params.method !== "POST" ||
      row.input.params.path !== expectedPath
    )
      fail(
        `${row.id} must be a live raw REST POST without an execution-intent flag`,
      );
    if (expectedPath === "/ssot/data-streams") {
      exactKeys(
        body,
        [
          "name",
          "label",
          "datastreamType",
          "connectorInfo",
          "dataLakeObjectInfo",
        ],
        `${row.id} body`,
      );
      if (body.datastreamType !== "SFDC")
        fail(`${row.id} needs a valid SFDC data stream type`);
    } else {
      if (body === null || typeof body !== "object" || Array.isArray(body))
        fail(`${row.id} needs a complete Data 360 object body`);
      const required =
        expectedPath === "/ssot/data-lake-objects"
          ? [
              "name",
              "label",
              "category",
              "dataspaceInfo",
              "dataLakeFieldInputRepresentations",
            ]
          : ["name", "label", "category", "fields"];
      if (required.some((key) => !Object.hasOwn(body, key)))
        fail(`${row.id} omits a required Data 360 object field`);
      const fields =
        expectedPath === "/ssot/data-lake-objects"
          ? body.dataLakeFieldInputRepresentations
          : body.fields;
      if (!Array.isArray(fields) || fields.length === 0)
        fail(`${row.id} needs at least one Data 360 object field`);
      if (
        expectedPath === "/ssot/data-model-objects" &&
        !["PROFILE", "ENGAGEMENT", "OTHER"].includes(body.category)
      )
        fail(`${row.id} has an unsupported Data Model Object category`);
    }
  }
}

function safeOperationIdentity(row, spec) {
  const command = row.input.command;
  if (spec.family === "agentscript") return spec.operation;
  if (spec.operation === "files.list") return "curl|files.list|types=canvas";
  const body = slackPayload(command, row.id);
  exactKeys(body, ["canvas_id", "criteria"], `${row.id} Slack body`);
  if (
    typeof body.canvas_id !== "string" ||
    !body.canvas_id ||
    body.criteria === null ||
    typeof body.criteria !== "object" ||
    Array.isArray(body.criteria)
  )
    fail(`${row.id} has invalid Slack lookup criteria`);
  return `curl|${spec.operation}|${JSON.stringify(canonical(body))}`;
}

function validateSafeCase(row, seenIds, seenGroups, variants) {
  exactKeys(
    row,
    [
      "id",
      "groupId",
      "family",
      "split",
      "expected",
      "rubricId",
      "tags",
      "toolName",
      "input",
      "observations",
    ],
    "safe addendum case",
  );
  const spec = safeGroups.get(row.groupId);
  const match = typeof row.id === "string" && row.id.match(/^(.+)-v([1-3])$/);
  if (
    !spec ||
    !match ||
    match[1] !== row.groupId ||
    seenIds.has(row.id) ||
    seenGroups.has(row.groupId) ||
    row.split !== spec.split ||
    row.family !== spec.family ||
    row.toolName !== "bash" ||
    row.expected !== "allow" ||
    row.rubricId !==
      (spec.family === "canvas" ? "canvas-read" : "ordinary-diagnostic-read") ||
    !Array.isArray(row.tags) ||
    row.tags.some((tag) => typeof tag !== "string")
  )
    fail(`Invalid or duplicate safe group/ID: ${String(row.id)}`);
  seenIds.add(row.id);
  const groupVariants = variants.get(row.groupId) ?? new Set();
  if (groupVariants.has(match[2])) fail(`Duplicate safe variant: ${row.id}`);
  groupVariants.add(match[2]);
  variants.set(row.groupId, groupVariants);
  exactKeys(row.input, ["command"], `${row.id} input`);
  const command = row.input.command;
  if (typeof command !== "string" || !command.trim())
    fail(`${row.id} has no command`);
  if (spec.family === "agentscript") {
    assertSandboxOrg(row.observations, row.id);
    if (
      !command.includes(spec.operation) ||
      !/--target-org(?:=|\s+)DevOrg\b/.test(command) ||
      !/^(?:sf |env NO_COLOR=1 sf )/.test(command)
    )
      fail(`${row.id} is not the expected targeted read-only Agent CLI action`);
  } else {
    exactKeys(row.observations, [], `${row.id} observations`);
    if (
      !command.startsWith("curl ") ||
      !command.includes(`https://slack.com/api/${spec.operation}`) ||
      !command.includes("${SLACK_TOKEN:?}") ||
      /\bxox[baprs]-/i.test(command)
    )
      fail(`${row.id} needs a credential-free Slack read request`);
    if (spec.operation === "files.list") {
      if (
        !command.includes("types=canvas") ||
        /(?:-X|--request)\s+POST\b/.test(command)
      )
        fail(`${row.id} must request a read-only Canvas file listing`);
    } else if (!command.includes("--data-binary")) {
      fail(`${row.id} needs a Canvas section lookup body`);
    }
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" } },
});
if (positionals.length || !values.output?.trim())
  fail("--output FILE is required");
const outputPath = resolve(values.output);
if (sources.some(({ path }) => path === outputPath))
  fail("Output must be separate from source files");
if (outputPath === rubricSource.path)
  fail("Output must be separate from the rubric");

const rubricBytes = await readFile(rubricSource.path);
if (sha256(rubricBytes) !== rubricSource.sha256)
  fail("Operation-policy v2 rubric source SHA-256 changed");

const parsed = [];
for (const source of sources) {
  const bytes = await readFile(source.path);
  if (sha256(bytes) !== source.sha256)
    fail(`Source SHA-256 changed: ${source.path}`);
  const data = JSON.parse(bytes);
  if (
    data.version !== 1 ||
    data.rubricVersion !== "operation-policy-v1" ||
    data.cases?.length !== source.count
  )
    fail(`Source version, rubric, or case count changed: ${source.path}`);
  parsed.push(data);
}
const [base, apex, semantic, safe] = parsed;
for (const [data, id] of [
  [apex, "host-hardened-apex-coverage-v1"],
  [semantic, "host-hardened-semantic-v2"],
  [safe, "host-hardened-safe-v3"],
]) {
  if (
    data.campaignId !== id ||
    data.baseCorpusSha256 !== sources[0].sha256 ||
    typeof data.provenance !== "string"
  )
    fail(`Addendum campaign metadata changed: ${id}`);
}

// Only original IDs and group IDs are read. No original held-out body or label
// enters validation, case authoring, or diagnostics.
const seenIds = new Set([...base.cases, ...apex.cases].map(({ id }) => id));
const seenGroups = new Set(
  [...base.cases, ...apex.cases].map(({ groupId }) => groupId),
);
const variants = new Map();
const operationByGroup = new Map();
const templateByGroup = new Map();
const inputsByGroup = new Map();
for (const row of semantic.cases) {
  validateSemanticCase(row, seenIds, seenGroups, variants);
  const operation = operationIdentity(row);
  const priorOperation = operationByGroup.get(row.groupId);
  if (priorOperation !== undefined && operation !== priorOperation)
    fail(`Variants in ${row.groupId} request different operations`);
  operationByGroup.set(row.groupId, operation);
  const template = semanticTemplate(row);
  const priorTemplate = templateByGroup.get(row.groupId);
  if (priorTemplate !== undefined && template !== priorTemplate)
    fail(`Variants in ${row.groupId} use different operation templates`);
  templateByGroup.set(row.groupId, template);
  const inputs = inputsByGroup.get(row.groupId) ?? new Set();
  const serialized = JSON.stringify(row.input);
  if (inputs.has(serialized)) fail(`Duplicate input variant in ${row.groupId}`);
  inputs.add(serialized);
  inputsByGroup.set(row.groupId, inputs);
}
if (variants.size !== expectedGroups.size) fail("Missing semantic groups");
for (const groupId of expectedGroups.keys()) {
  if (
    JSON.stringify([...(variants.get(groupId) ?? [])].sort()) !==
    '["1","2","3"]'
  )
    fail(`Expected three related variants in ${groupId}`);
}
const splitCounts = semantic.cases.reduce((result, row) => {
  result[row.split] = (result[row.split] ?? 0) + 1;
  return result;
}, {});
if (
  JSON.stringify(splitCounts) !==
  JSON.stringify({ train: 18, validation: 18, test: 18 })
)
  fail("Unexpected split counts in semantic addendum");

const safeSeenIds = new Set([...seenIds]);
const safeSeenGroups = new Set([
  ...seenGroups,
  ...semantic.cases.map(({ groupId }) => groupId),
]);
const safeVariants = new Map();
const safeOperations = new Map();
const safeTemplates = new Map();
const safeInputs = new Map();
for (const row of safe.cases) {
  validateSafeCase(row, safeSeenIds, safeSeenGroups, safeVariants);
  const spec = safeGroups.get(row.groupId);
  const operation = safeOperationIdentity(row, spec);
  const priorOperation = safeOperations.get(row.groupId);
  if (priorOperation !== undefined && operation !== priorOperation)
    fail(`Safe variants in ${row.groupId} request different operations`);
  safeOperations.set(row.groupId, operation);
  safeTemplates.set(row.groupId, safeTemplate(spec));
  const inputs = safeInputs.get(row.groupId) ?? new Set();
  const serialized = JSON.stringify(row.input);
  if (inputs.has(serialized)) fail(`Duplicate input variant in ${row.groupId}`);
  inputs.add(serialized);
  safeInputs.set(row.groupId, inputs);
}
if (safeVariants.size !== safeGroups.size) fail("Missing safe groups");
for (const groupId of safeGroups.keys()) {
  if (
    JSON.stringify([...(safeVariants.get(groupId) ?? [])].sort()) !==
    '["1","2","3"]'
  )
    fail(`Expected three related variants in ${groupId}`);
}
const safeSplitFamilyCounts = safe.cases.reduce((result, row) => {
  const key = `${row.split}/${row.family}`;
  result[key] = (result[key] ?? 0) + 1;
  return result;
}, {});
if (
  JSON.stringify(canonical(safeSplitFamilyCounts)) !==
  JSON.stringify(
    canonical({
      "train/agentscript": 3,
      "validation/agentscript": 3,
      "test/agentscript": 3,
      "train/canvas": 3,
      "validation/canvas": 3,
      "test/canvas": 3,
    }),
  )
)
  fail("Unexpected safe split/family counts");

const newGroups = [
  ...[...expectedGroups.entries()].map(([id, spec]) => ({
    id,
    split: spec.split,
    family: spec.family,
    operation: operationByGroup.get(id),
    template: templateByGroup.get(id),
  })),
  ...[...safeGroups.entries()].map(([id, spec]) => ({
    id,
    split: spec.split,
    family: spec.family,
    operation: safeOperations.get(id),
    template: safeTemplates.get(id),
  })),
];
for (let leftIndex = 0; leftIndex < newGroups.length; leftIndex++) {
  for (
    let rightIndex = leftIndex + 1;
    rightIndex < newGroups.length;
    rightIndex++
  ) {
    const left = newGroups[leftIndex];
    const right = newGroups[rightIndex];
    if (left.split === right.split) continue;
    // A save chord depends on the focused Salesforce page. Other explicit
    // committing browser gestures remain host-floored, so browser is the one
    // contextual exception to stable cross-split template identity.
    if (left.family === "browser" || right.family === "browser") continue;
    if (left.operation === right.operation)
      fail(
        `New groups repeat an operation across splits: ${left.id}, ${right.id}`,
      );
    // TRAIN and validation can share a command head for candidate selection.
    // Held-out TEST uses a distinct CLI or API operation template where the
    // source exposes one, avoiding a trivial syntax memorization test.
    if (
      ((left.split === "train" && right.split === "test") ||
        (left.split === "test" && right.split === "train")) &&
      left.template === right.template
    )
      fail(`TRAIN and TEST repeat a template: ${left.id}, ${right.id}`);
  }
}

const composed = {
  version: base.version,
  rubricVersion: "operation-policy-v2",
  provenance: `${base.provenance} ${apex.provenance} ${semantic.provenance} ${safe.provenance}`,
  grouping: `${base.grouping} The 27 addendum groups remain disjoint by split in the v3 campaign.`,
  campaign: {
    id: campaignId,
    baseRubricVersion: base.rubricVersion,
    rubricSourceSha256: rubricSource.sha256,
    baseCorpusSha256: sources[0].sha256,
    apexAddendumSha256: sources[1].sha256,
    semanticAddendumSha256: sources[2].sha256,
    safeAddendumSha256: sources[3].sha256,
  },
  cases: [...base.cases, ...apex.cases, ...semantic.cases, ...safe.cases],
};
const encoded = JSON.stringify(composed, null, 2) + "\n";
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, encoded, { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    output: outputPath,
    campaignId,
    cases: composed.cases.length,
    splitCounts,
    safeSplitFamilyCounts,
    baseCorpusSha256: sources[0].sha256,
    apexAddendumSha256: sources[1].sha256,
    semanticAddendumSha256: sources[2].sha256,
    safeAddendumSha256: sources[3].sha256,
    rubricSourceSha256: rubricSource.sha256,
    sha256: sha256(encoded),
  }),
);
