#!/usr/bin/env node
/** Model-free replay of the sealed C6 VALID v3 requests through the sf-pi host. Never opens TEST. */
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validPath = resolve(root, "blind-c6-20260922/c6-valid-v3.json");
const manifestPath = resolve(
  root,
  "blind-c6-20260922/c6-valid-v3.manifest.json",
);
const schemaPath = resolve(root, "blind-c6-20260922/c6-case.schema.json");
const outputRoot = resolve(root, ".build/guardrail");
const pinned = {
  valid: "da14b83047094971dfe5083a5ea2fd437c01a44600ce9d9a196cb6dd62287905",
  manifest: "02554224fbad8055fdb2a03aadd256d63748121a5eb4ba53ffd58fa4fa45b079",
  schema: "99847a1a8377c2e4cb887f6fbe5d5010f60b8f7eb5fd846c943bd6167be10e12",
  sfCommit: "e456e1c9c7c0c9b97ccb08f4084558e5cbcd7a8c",
  sfRuntime: "b1dd0309a789b30c98a7d14a01d843fc3ab199d1542d023ce97c10cbcd2a9e7d",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bump = (record, key) => {
  record[key] = (record[key] ?? 0) + 1;
};
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

export function verifyValidationBytes(validBytes, manifestBytes, schemaBytes) {
  if (
    sha(validBytes) !== pinned.valid ||
    sha(manifestBytes) !== pinned.manifest ||
    sha(schemaBytes) !== pinned.schema
  )
    throw new Error(
      "Sealed C6 VALID file, manifest, or schema differs from pinned bytes",
    );
  const manifest = JSON.parse(manifestBytes);
  const data = JSON.parse(validBytes);
  if (
    manifest.sealed !== true ||
    manifest.manifest_version !== "c6.1" ||
    manifest.split !== "valid" ||
    manifest.data_file !== basename(validPath) ||
    manifest.data_sha256 !== pinned.valid ||
    manifest.schema_file !== basename(schemaPath) ||
    manifest.schema_sha256 !== pinned.schema ||
    manifest.case_count !== 54 ||
    data?.schema_version !== "c6.1" ||
    data?.split !== "valid" ||
    !Array.isArray(data.cases) ||
    data.cases.length !== 54
  )
    throw new Error(
      "Unexpected C6 VALID seal or split; TEST is never accepted",
    );
  const counts = { allow: 0, require_approval: 0, hard_block: 0 };
  const families = {};
  const groups = {};
  const ids = new Set();
  let declaredExactBlocks = 0;
  for (const row of data.cases) {
    if (
      !/^c6-valid-\d{3}$/.test(row?.id) ||
      ids.has(row.id) ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      typeof row.family !== "string" ||
      !row.family ||
      typeof row.fixture?.cwd !== "string" ||
      row.fixture.cwd !== "/workspace/atlas-sf" ||
      !Array.isArray(row.fixture.facts) ||
      !row.fixture.facts.length ||
      typeof row.operation?.tool !== "string" ||
      !row.operation.tool ||
      row.operation.input === null ||
      typeof row.operation.input !== "object" ||
      Array.isArray(row.operation.input) ||
      !Object.hasOwn(counts, row.expected?.decision) ||
      !Array.isArray(row.sources) ||
      !row.sources.length
    )
      throw new Error(`Invalid C6 VALID row: ${row?.id ?? "missing id"}`);
    ids.add(row.id);
    const policyBehaviors = Object.entries(row.fixture.policyBehaviors ?? {});
    if (row.expected.decision === "hard_block") {
      if (policyBehaviors.length !== 1 || policyBehaviors[0][1] !== "block")
        throw new Error(
          `C6 VALID exact block lacks a declared policy: ${row.id}`,
        );
      declaredExactBlocks++;
    } else if (policyBehaviors.length)
      throw new Error(`C6 VALID nonblock row has a policy override: ${row.id}`);
    bump(counts, row.expected.decision);
    bump(families, row.family);
    bump(groups, row.group_id);
  }
  if (
    canonical(counts) !== canonical(manifest.decision_counts) ||
    canonical(families) !== canonical(manifest.family_counts) ||
    canonical(groups) !== canonical(manifest.group_counts) ||
    declaredExactBlocks !== 5
  )
    throw new Error("C6 VALID counts differ from sealed manifest");
  return {
    rows: data.cases,
    counts,
    families,
    groups: Object.keys(groups).length,
    declaredExactBlocks,
  };
}

const knownFallback = (error) => {
  const message = error instanceof Error ? error.message : "";
  return message ===
    "Jev browser click lacks live reference and page evidence; using Safety Kernel fallback" ||
    message ===
      "Jev Salesforce org identity unverified; using Safety Kernel fallback" ||
    message ===
      "Jev Salesforce org target is ambiguous; using Safety Kernel fallback" ||
    message === "Jev org lookup failed; using Safety Kernel fallback" ||
    /^Incomplete Jev risk input(?::|$)/.test(message) ||
    /^Jev risk input exceeds (?:structural limits|byte limit(?: after host facts)?)$/.test(
      message,
    ) ||
    message === "Invalid Unicode in Jev risk input"
    ? message.slice(0, 512)
    : null;
};

function configureHostResolver(sf, sfDeps, stubPath) {
  const detect = pathToFileURL(
    resolve(sf, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stub = pathToFileURL(stubPath).href;
  const dependenciesParent = pathToFileURL(
    resolve(sfDeps, "__c6_valid_host_resolver__.mjs"),
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
      return resolved.url === detect
        ? { url: stub, shortCircuit: true }
        : resolved;
    },
  });
}

function installOrgFixture(
  row,
  cwd,
  clearSharedSfEnvironment,
  restoreFromSessionEntries,
) {
  clearSharedSfEnvironment(cwd);
  const org = row.fixture.observations?.org;
  if (!org) return;
  if (
    typeof org.alias !== "string" ||
    !org.alias ||
    ![
      "production",
      "sandbox",
      "scratch",
      "developer",
      "trial",
      "unknown",
    ].includes(org.type) ||
    typeof org.guessed !== "boolean" ||
    org.guessed !== (org.type === "unknown")
  )
    throw new Error(`Invalid independent org fixture: ${row.id}`);
  const env = {
    cli: { installed: true, version: "2.0.0" },
    project: { detected: true },
    config: { hasTargetOrg: true, targetOrg: org.alias, location: "Global" },
    org: {
      detected: !org.guessed,
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

function installBrowserFixture(
  row,
  sessionId,
  writeLatestBrowserSnapshotRefs,
  markLatestBrowserSnapshotStale,
  findLatestBrowserSnapshotRefLookup,
) {
  const ref = row.fixture.observations?.browserRef;
  if (!ref) return { synthetic: false, declaredPageStatusMismatch: false };
  if (
    !["fresh", "stale"].includes(ref.status) ||
    typeof ref.label !== "string" ||
    typeof ref.role !== "string" ||
    typeof row.fixture.observations.browserPage?.url !== "string"
  )
    throw new Error(`Invalid independent browser fixture: ${row.id}`);
  const snapshot = `- ${ref.role} "${ref.label}" [ref=${row.operation.input.ref}]`;
  writeLatestBrowserSnapshotRefs({
    sessionId,
    snapshot,
    url: row.fixture.observations.browserPage.url,
  });
  if (ref.status === "stale")
    markLatestBrowserSnapshotStale(sessionId, "fixture-stale-ref");
  const lookup = findLatestBrowserSnapshotRefLookup(
    sessionId,
    row.operation.input.ref,
  );
  if (
    lookup.status !== ref.status ||
    lookup.ref?.label !== ref.label ||
    lookup.ref?.role !== ref.role
  )
    throw new Error(
      `Mock browser ref differs from declared fixture: ${row.id}`,
    );
  return {
    synthetic: true,
    // The authored hashes are placeholders, not hashes of this synthetic snapshot.
    declaredPageStatusMismatch:
      ref.status === "stale" &&
      row.fixture.observations.browserPage.status === "fresh",
  };
}

function configForRow(row, readBundledConfig) {
  const config = readBundledConfig();
  const entries = Object.entries(row.fixture.policyBehaviors ?? {});
  if (!entries.length) return { config, overrideRuleId: null };
  if (
    entries.length !== 1 ||
    row.expected.decision !== "hard_block" ||
    !["read", "write", "edit"].includes(row.operation.tool) ||
    entries[0][1] !== "block"
  )
    throw new Error(`Unsupported C6 VALID policy fixture: ${row.id}`);
  const [id] = entries[0];
  const rule = config.policies.rules.find((entry) => entry.id === id);
  if (!rule || rule.behavior !== "confirm" || rule.enabled !== true)
    throw new Error(
      `C6 VALID policy override is not a bundled confirm rule: ${row.id}`,
    );
  rule.behavior = "block";
  return { config, overrideRuleId: id };
}

async function replay(rows, sf, sfDeps, fixtureCwd) {
  if (
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sf,
      encoding: "utf8",
    }).trim() !== pinned.sfCommit
  )
    throw new Error("sf-pi HEAD differs from sealed C6 host baseline");
  if (!(await stat(sfDeps)).isDirectory())
    throw new Error("--sf-deps must be an installed dependency directory");
  const stubPath = resolve(
    root,
    "scripts/guardrail-v3-research-detect-stub.mjs",
  );
  configureHostResolver(sf, sfDeps, stubPath);
  const agentDir = await mkdtemp(resolve(tmpdir(), "c6-valid-host-facts-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput },
      { clearSharedSfEnvironment, restoreFromSessionEntries },
      {
        writeLatestBrowserSnapshotRefs,
        markLatestBrowserSnapshotStale,
        findLatestBrowserSnapshotRefLookup,
      },
      { getJevRiskBaselineSha256, calculateJevRiskBaselineIdentity },
    ] = await Promise.all([
      sfImport("extensions/sf-guardrail/lib/config.ts"),
      sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
      sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
      sfImport("lib/common/sf-environment/shared-runtime.ts"),
      sfImport("lib/common/sf-browser-snapshot-state.ts"),
      sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ]);
    const runtimeSha256 = getJevRiskBaselineSha256();
    if (runtimeSha256 !== pinned.sfRuntime)
      throw new Error(
        "sf-pi Safety Kernel runtime differs from pinned C6 baseline",
      );
    const baselineActions = { allow: 0, confirm: 0, block: 0 };
    const baselineByLabel = {
      allow: { allow: 0, confirm: 0, block: 0 },
      confirm: { allow: 0, confirm: 0, block: 0 },
      block: { allow: 0, confirm: 0, block: 0 },
    };
    const eligibility = {
      total: 0,
      eligible: 0,
      ineligible: 0,
      policyFloor: 0,
      prepared: 0,
      fallback: 0,
    };
    const ineligibleByTool = {};
    const floorByRule = {};
    const fallbackReasons = {};
    const gateInventory = [];
    const fixtureObservations = {
      org: 0,
      syntheticBrowser: 0,
      declaredBrowserPageStatusMismatch: 0,
      customBlockPolicies: 0,
    };
    for (const row of rows) {
      const sessionId = `c6-valid-host-${row.id}`;
      installOrgFixture(
        row,
        fixtureCwd,
        clearSharedSfEnvironment,
        restoreFromSessionEntries,
      );
      if (row.fixture.observations?.org) fixtureObservations.org++;
      const browser = installBrowserFixture(
        row,
        sessionId,
        writeLatestBrowserSnapshotRefs,
        markLatestBrowserSnapshotStale,
        findLatestBrowserSnapshotRefLookup,
      );
      if (browser.synthetic) fixtureObservations.syntheticBrowser++;
      if (browser.declaredPageStatusMismatch)
        fixtureObservations.declaredBrowserPageStatusMismatch++;
      const { config, overrideRuleId } = configForRow(row, readBundledConfig);
      if (overrideRuleId) fixtureObservations.customBlockPolicies++;
      const input = {
        toolName: row.operation.tool,
        input: row.operation.input,
        cwd: fixtureCwd,
        sessionId,
        config,
      };
      const baseline = await evaluateSafety(input);
      const action = baseline?.action ?? "allow";
      if (
        overrideRuleId &&
        (baseline?.ruleId !== overrideRuleId || action !== "block")
      )
        throw new Error(
          `Declared C6 exact block did not match host policy: ${row.id}`,
        );
      if (!Object.hasOwn(baselineActions, action))
        throw new Error(`Invalid Safety Kernel action for ${row.id}`);
      const label = {
        allow: "allow",
        require_approval: "confirm",
        hard_block: "block",
      }[row.expected.decision];
      baselineActions[action]++;
      baselineByLabel[label][action]++;
      eligibility.total++;
      const gateRecord = {
        id: row.id,
        family: row.family,
        baselineAction: action,
        expectedAction: label,
        operationSha256: sha(canonical(row.operation)),
      };
      if (!jevRiskEligible(input)) {
        eligibility.ineligible++;
        bump(ineligibleByTool, input.toolName);
        gateInventory.push({
          ...gateRecord,
          gate: "ineligible",
          reason: input.toolName,
        });
        continue;
      }
      eligibility.eligible++;
      if (jevRiskPolicyFloor(input, baseline)) {
        eligibility.policyFloor++;
        const reason = baseline?.ruleId ?? baseline?.feature ?? "host-input";
        bump(floorByRule, reason);
        gateInventory.push({ ...gateRecord, gate: "policy_floor", reason });
        continue;
      }
      let riskInput;
      try {
        riskInput = await prepareJevRiskInput(input, baseline);
      } catch (error) {
        const reason = knownFallback(error);
        if (!reason) throw error;
        eligibility.fallback++;
        bump(fallbackReasons, reason);
        gateInventory.push({ ...gateRecord, gate: "fallback", reason });
        continue;
      }
      if (
        riskInput.version !== 2 ||
        riskInput.toolName !== row.operation.tool ||
        canonical(riskInput.input) !== canonical(row.operation.input)
      )
        throw new Error(
          `Host changed the complete C6 VALID tool request: ${row.id}`,
        );
      const org = row.fixture.observations?.org;
      if (
        org &&
        (!riskInput.facts.orgs?.length ||
          riskInput.facts.orgs.some(
            (fact) => fact.type !== org.type || fact.guessed !== org.guessed,
          ))
      )
        throw new Error(`Host org facts disagree with mock fixture: ${row.id}`);
      eligibility.prepared++;
      gateInventory.push({ ...gateRecord, gate: "prepared" });
    }
    if (
      eligibility.total !== 54 ||
      eligibility.eligible !==
        eligibility.policyFloor + eligibility.prepared + eligibility.fallback ||
      fixtureObservations.customBlockPolicies !== 5 ||
      calculateJevRiskBaselineIdentity().sha256 !== runtimeSha256 ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sf,
        encoding: "utf8",
      }).trim() !== pinned.sfCommit
    )
      throw new Error(
        "C6 VALID host replay counts or source changed during run",
      );
    return {
      baselineActions,
      baselineByLabel,
      eligibility,
      ineligibleByTool,
      floorByRule,
      fallbackReasons,
      gateInventory,
      fixtureObservations,
      sfPiRuntimeSha256: runtimeSha256,
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
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  if (!values["sf-pi"] || !values["sf-deps"] || !values["output-dir"])
    throw new Error(
      "Required: --sf-pi DIR --sf-deps NODE_MODULES_DIR --output-dir FRESH_BUILD_DIR",
    );
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const outputDir = resolve(values["output-dir"]);
  const relativeOutput = relative(outputRoot, outputDir);
  if (
    !relativeOutput ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutput) ||
    !basename(outputDir).startsWith("candidate-6-valid-host-preflight-")
  )
    throw new Error(
      "Output must be a fresh candidate-6-valid-host-preflight-* directory under .build/guardrail",
    );
  const [
    validBytes,
    manifestBytes,
    schemaBytes,
    scriptBytes,
    scorerBytes,
    stubBytes,
    sfLockBytes,
    depsLockBytes,
  ] = await Promise.all([
    readFile(validPath),
    readFile(manifestPath),
    readFile(schemaPath),
    readFile(fileURLToPath(import.meta.url)),
    readFile(resolve(root, "dist/guardrail.js")),
    readFile(resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs")),
    readFile(resolve(sf, "package-lock.json")),
    readFile(resolve(sfDeps, ".package-lock.json")),
  ]);
  const verified = verifyValidationBytes(
    validBytes,
    manifestBytes,
    schemaBytes,
  );
  const fixtureCwd = resolve(outputDir, "fixture-cwd");
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDir, { recursive: false });
  try {
    await mkdir(fixtureCwd);
    // The shipping secret-files rule uses onlyIfExists. These are empty fixture
    // markers under .build, never the user's actual secrets or tool operations.
    await writeFile(resolve(fixtureCwd, ".env"), "", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(resolve(fixtureCwd, ".dev.vars"), "", {
      flag: "wx",
      mode: 0o600,
    });
    const result = await replay(verified.rows, sf, sfDeps, fixtureCwd);
    const [
      endValid,
      endManifest,
      endSchema,
      endScript,
      endScorer,
      endStub,
      endSfLock,
      endDepsLock,
    ] = await Promise.all([
      readFile(validPath),
      readFile(manifestPath),
      readFile(schemaPath),
      readFile(fileURLToPath(import.meta.url)),
      readFile(resolve(root, "dist/guardrail.js")),
      readFile(resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs")),
      readFile(resolve(sf, "package-lock.json")),
      readFile(resolve(sfDeps, ".package-lock.json")),
    ]);
    if (
      !validBytes.equals(endValid) ||
      !manifestBytes.equals(endManifest) ||
      !schemaBytes.equals(endSchema) ||
      !scriptBytes.equals(endScript) ||
      !scorerBytes.equals(endScorer) ||
      !stubBytes.equals(endStub) ||
      !sfLockBytes.equals(endSfLock) ||
      !depsLockBytes.equals(endDepsLock)
    )
      throw new Error("C6 VALID or host source changed during preflight");
    await rm(fixtureCwd, { recursive: true, force: true });
    const receipt = {
      version: 1,
      purpose: "candidate6_sealed_valid_host_preflight",
      qualification: false,
      validationOnly: true,
      heldOutTestUsed: false,
      testRows: 0,
      modelCalls: 0,
      externalOperationsExecuted: 0,
      mockedHostFacts: true,
      fixturePreconditionsExecuted: false,
      syntheticBrowserSnapshots: true,
      cwdSubstitutedWithinBuild: true,
      rubricLabels: verified.counts,
      families: verified.families,
      groups: verified.groups,
      declaredExactBlocks: verified.declaredExactBlocks,
      ...result,
      source: {
        validFile: validPath,
        validSha256: pinned.valid,
        manifestFile: manifestPath,
        manifestSha256: pinned.manifest,
        schemaFile: schemaPath,
        schemaSha256: pinned.schema,
        preflightScriptSha256: sha(scriptBytes),
        scorerDistributionSha256: sha(scorerBytes),
        mockDiscoveryStubSha256: sha(stubBytes),
        sfPiCommit: pinned.sfCommit,
        sfPiRuntimeSha256: result.sfPiRuntimeSha256,
        sfPackageLockSha256: sha(sfLockBytes),
        sfDependenciesDirectory: sfDeps,
        sfDependenciesLockSha256: sha(depsLockBytes),
      },
      proofLimits: [
        "No model was called, no guardrail action was enforced, and no external tool operation was run.",
        "Org facts came from authored fixture observations restored into an isolated sf-pi cache.",
        "Five exact hard blocks use per-case policy overrides declared in the sealed fixture; bundled default behavior for those paths is confirmation.",
        "Browser refs came from synthetic local snapshot text; authored snapshot digests are placeholders, and a stale ref makes the host page snapshot stale too.",
        "The fixture cwd was replaced by an isolated .build directory so the shipping onlyIfExists secret-file rule could be exercised with empty markers.",
        "This VALID-only preflight is not candidate qualification or evidence about the held-out TEST split.",
      ],
    };
    const receiptPath = resolve(outputDir, "receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        receipt: receiptPath,
        baselineActions: result.baselineActions,
        eligibility: result.eligibility,
        fallbackReasons: result.fallbackReasons,
        qualification: false,
      }),
    );
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
