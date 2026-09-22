#!/usr/bin/env node
/** Model-free, aggregate-only host preparation check for appended blind TEST rows. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const testV2 = resolve(here, "c6-test-v2.json");
const testV3 = resolve(here, "c6-test-v3.draft.json");
const testManifest = resolve(here, "c6-test-v3.draft.manifest.json");
const schema = resolve(here, "c6-case-v2.schema.json");
const stub = resolve(project, "scripts/guardrail-v3-research-detect-stub.mjs");
const baseSha256 = "7a0fa5fca18fbcffb5824011884359ceccfa139a42480499b2197a26bb3fc9d1";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

function configureResolver(sf, sfDeps) {
  const detectUrl = pathToFileURL(resolve(sf, "lib/common/sf-environment/detect.ts")).href;
  const stubUrl = pathToFileURL(stub).href;
  const depsParent = pathToFileURL(resolve(sfDeps, "__c6_test_host_resolver__.mjs")).href;
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
        ) throw error;
        resolved = nextResolve(specifier, { ...context, parentURL: depsParent });
      }
      return resolved.url === detectUrl
        ? { url: stubUrl, shortCircuit: true }
        : resolved;
    },
  });
}

function installOrgFixture(row, cwd, clearSharedSfEnvironment, restoreFromSessionEntries) {
  clearSharedSfEnvironment(cwd);
  const org = row.fixture.observations?.org;
  if (!org) return;
  if (
    typeof org.alias !== "string" ||
    !org.alias ||
    org.type !== "production" ||
    org.guessed !== false
  ) throw new Error("org-fixture-invalid");
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
  restoreFromSessionEntries({
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "sf-environment", data: { env } }],
    },
  }, cwd);
}

function installBrowserFixture(row, sessionId, writeLatestBrowserSnapshotRefs, findLatestBrowserSnapshotRefLookup, findLatestBrowserSnapshotPageLookup) {
  if (row.operation.tool !== "sf_browser_click") return;
  const ref = row.fixture.observations?.browserRef;
  const page = row.fixture.observations?.browserPage;
  if (
    ref?.status !== "fresh" || page?.status !== "fresh" ||
    typeof ref.line !== "string" || !ref.line ||
    typeof ref.label !== "string" || !ref.label ||
    typeof ref.role !== "string" || !ref.role ||
    typeof page.snapshot !== "string" || !page.snapshot ||
    typeof page.url !== "string" || !page.url ||
    !page.snapshot.split(/\r?\n/).map((line) => line.trim()).includes(ref.line) ||
    sha(page.snapshot) !== page.snapshotSha256 ||
    page.snapshotSha256 !== ref.snapshotSha256
  ) throw new Error("browser-fixture-invalid");
  const stored = writeLatestBrowserSnapshotRefs({
    sessionId, snapshot: page.snapshot, url: page.url,
  });
  const refLookup = findLatestBrowserSnapshotRefLookup(sessionId, row.operation.input.ref);
  const pageLookup = findLatestBrowserSnapshotPageLookup(sessionId);
  if (
    stored.snapshotSha256 !== page.snapshotSha256 ||
    refLookup.status !== "fresh" ||
    pageLookup.status !== "fresh" ||
    refLookup.ref?.line !== ref.line ||
    refLookup.ref?.label !== ref.label ||
    refLookup.ref?.role !== ref.role ||
    refLookup.session?.snapshotSha256 !== page.snapshotSha256 ||
    pageLookup.session?.snapshotSha256 !== page.snapshotSha256 ||
    refLookup.session?.url !== page.url ||
    pageLookup.session?.url !== page.url
  ) throw new Error("browser-snapshot-mismatch");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      "sf-head": { type: "string" },
      "sf-runtime": { type: "string" },
      "receipt": { type: "string" },
    },
  });
  if (!values["sf-pi"] || !values["sf-deps"] || !values["sf-head"] || !values["sf-runtime"] || !values.receipt)
    throw new Error("missing-required-arguments");
  const sf = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const receiptPath = resolve(values.receipt);
  if (!(await stat(sfDeps)).isDirectory()) throw new Error("dependencies-unavailable");
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: sf, encoding: "utf8" }).trim() !== values["sf-head"])
    throw new Error("sf-head-mismatch");
  const [baseBytes, testBytes, manifestBytes, schemaBytes, scriptBytes, stubBytes] = await Promise.all([
    readFile(testV2), readFile(testV3), readFile(testManifest), readFile(schema),
    readFile(fileURLToPath(import.meta.url)), readFile(stub),
  ]);
  if (sha(baseBytes) !== baseSha256) throw new Error("base-seal-mismatch");
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.status !== "draft" || manifest.sealed !== false ||
    manifest.data_sha256 !== sha(testBytes) ||
    manifest.schema_sha256 !== sha(schemaBytes) ||
    manifest.base_sha256 !== baseSha256
  ) throw new Error("draft-manifest-mismatch");
  const base = JSON.parse(baseBytes);
  const draft = JSON.parse(testBytes);
  if (
    draft.split !== "test" || draft.schema_version !== "c6.1" ||
    !Array.isArray(draft.cases) || draft.cases.length !== 55 ||
    canonical(draft.cases.slice(0, base.cases.length)) !== canonical(base.cases)
  ) throw new Error("test-draft-shape-mismatch");
  const appended = draft.cases.slice(base.cases.length);
  if (
    appended.length !== 8 ||
    appended.filter((row) => row.operation?.tool === "bash").length !== 6 ||
    appended.filter((row) => row.operation?.tool === "sf_browser_click").length !== 2
  )
    throw new Error("append-shape-mismatch");

  configureResolver(sf, sfDeps);
  const agentDir = await mkdtemp(resolve(tmpdir(), "c6-test-agent-"));
  const fixtureCwd = await mkdtemp(resolve(tmpdir(), "c6-test-fixture-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sfImport = (path) => import(pathToFileURL(resolve(sf, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput, jevBrowserClickEvidenceFingerprint },
      { clearSharedSfEnvironment, restoreFromSessionEntries },
      { writeLatestBrowserSnapshotRefs, findLatestBrowserSnapshotRefLookup, findLatestBrowserSnapshotPageLookup },
      { getJevRiskBaselineSha256, calculateJevRiskBaselineIdentity },
    ] = await Promise.all([
      sfImport("extensions/sf-guardrail/lib/config.ts"),
      sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
      sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
      sfImport("lib/common/sf-environment/shared-runtime.ts"),
      sfImport("lib/common/sf-browser-snapshot-state.ts"),
      sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ]);
    const runtime = getJevRiskBaselineSha256();
    if (runtime !== values["sf-runtime"] || calculateJevRiskBaselineIdentity().sha256 !== runtime)
      throw new Error("sf-runtime-mismatch");
    const familyCounts = {};
    const gateCounts = { prepared: 0, floor: 0, fallback: 0, ineligible: 0 };
    for (const [index, row] of appended.entries()) {
      installOrgFixture(row, fixtureCwd, clearSharedSfEnvironment, restoreFromSessionEntries);
      const sessionId = `c6-test-v3-aggregate-${index}`;
      installBrowserFixture(
        row, sessionId, writeLatestBrowserSnapshotRefs,
        findLatestBrowserSnapshotRefLookup, findLatestBrowserSnapshotPageLookup,
      );
      const input = {
        toolName: row.operation.tool,
        input: row.operation.input,
        cwd: fixtureCwd,
        sessionId,
        config: readBundledConfig(),
      };
      const browserEvidenceBeforeBaseline = row.operation.tool === "sf_browser_click"
        ? jevBrowserClickEvidenceFingerprint(input)
        : undefined;
      if (row.operation.tool === "sf_browser_click" && !browserEvidenceBeforeBaseline)
        throw new Error("browser-evidence-unavailable");
      const baseline = await evaluateSafety(input);
      if (
        row.operation.tool === "sf_browser_click" &&
        (baseline?.action ?? "allow") !== "allow"
      ) throw new Error("browser-baseline-not-allow");
      const family = row.family === "slack-canvas" ? "canvas"
        : row.family === "browser-commit" ? "browser" : row.family;
      const decision = row.expected?.decision;
      if (!["allow", "require_approval"].includes(decision)) throw new Error("append-label-shape-mismatch");
      familyCounts[family] ??= { safe: 0, risky: 0, prepared_safe: 0, prepared_risky: 0 };
      familyCounts[family][decision === "allow" ? "safe" : "risky"]++;
      if (!jevRiskEligible(input)) {
        gateCounts.ineligible++;
        continue;
      }
      if (jevRiskPolicyFloor(input, baseline)) {
        gateCounts.floor++;
        continue;
      }
      try {
        if (
          row.operation.tool === "sf_browser_click" &&
          jevBrowserClickEvidenceFingerprint(input) !== browserEvidenceBeforeBaseline
        ) throw new Error("browser-evidence-changed");
        const riskInput = await prepareJevRiskInput(input, baseline);
        if (
          riskInput.version !== 2 ||
          riskInput.toolName !== row.operation.tool ||
          canonical(riskInput.input) !== canonical(row.operation.input)
        ) throw new Error("request-integrity-mismatch");
        const org = row.fixture.observations?.org;
        if (
          org &&
          (!riskInput.facts.orgs?.length || riskInput.facts.orgs.some((fact) => fact.type !== org.type || fact.guessed !== org.guessed))
        ) throw new Error("org-facts-mismatch");
        if (
          row.operation.tool === "sf_browser_click" &&
          (
            riskInput.facts.browserRef?.status !== "fresh" ||
            riskInput.facts.browserRef?.snapshotSha256 !== row.fixture.observations.browserRef.snapshotSha256 ||
            riskInput.facts.browserPage?.snapshotSha256 !== row.fixture.observations.browserPage.snapshotSha256 ||
            jevBrowserClickEvidenceFingerprint(input) !== browserEvidenceBeforeBaseline
          )
        ) throw new Error("browser-facts-mismatch");
        gateCounts.prepared++;
        familyCounts[family][decision === "allow" ? "prepared_safe" : "prepared_risky"]++;
      } catch (error) {
        if (["request-integrity-mismatch", "org-facts-mismatch", "browser-facts-mismatch", "browser-evidence-changed"].includes(error.message)) throw error;
        gateCounts.fallback++;
      }
    }
    if (Object.values(gateCounts).reduce((a, b) => a + b, 0) !== appended.length)
      throw new Error("gate-count-mismatch");
    const [endBase, endTest, endManifest, endSchema, endScript, endStub] = await Promise.all([
      readFile(testV2), readFile(testV3), readFile(testManifest), readFile(schema),
      readFile(fileURLToPath(import.meta.url)), readFile(stub),
    ]);
    if (
      !baseBytes.equals(endBase) || !testBytes.equals(endTest) ||
      !manifestBytes.equals(endManifest) || !schemaBytes.equals(endSchema) ||
      !scriptBytes.equals(endScript) || !stubBytes.equals(endStub) ||
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: sf, encoding: "utf8" }).trim() !== values["sf-head"] ||
      getJevRiskBaselineSha256() !== runtime
    ) throw new Error("source-changed-during-replay");
    const receipt = {
      version: 1,
      purpose: "c6_test_v3_appended_model_free_host_replay",
      qualification: false,
      model_calls: 0,
      external_operations_executed: 0,
      test_v2_sha256: baseSha256,
      test_v3_draft_sha256: sha(testBytes),
      test_manifest_sha256: sha(manifestBytes),
      script_sha256: sha(scriptBytes),
      sf_head: values["sf-head"],
      sf_runtime_sha256: runtime,
      appended_case_count: appended.length,
      gate_counts: gateCounts,
      canonical_family_safe_risky_counts: familyCounts,
      proof_limit: "Mocked host facts and source-only preparation; no model inference or live external operation.",
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ receipt: receiptPath, gate_counts: gateCounts, canonical_family_safe_risky_counts: familyCounts }));
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(fixtureCwd, { recursive: true, force: true }),
    ]);
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ replay_status: "failed", error_type: error?.constructor?.name ?? "unknown" }));
  process.exitCode = 1;
}
