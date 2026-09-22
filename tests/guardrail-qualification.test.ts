import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { canonical } from "../src/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../src/guardrail.js";
import {
  GUARDRAIL_REQUIRED_FAMILIES,
  GUARDRAIL_BRIDGE_EXPORTER_SOURCE,
  assertGuardrailFreeze,
  guardrailBridgeProvenance,
  qualifyGuardrail,
  freezeGuardrailCandidate,
  verifyGuardrailQualification,
  type GuardrailEvaluationRecord,
  type GuardrailInventoryRecord,
  type GuardrailQualification,
  type GuardrailBridgeProvenance,
} from "../src/guardrail-evaluation.js";
const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const identity = {
  modelSha256: "a".repeat(64),
  corpusSha256: "b".repeat(64),
  baselineSourceSha256: "c".repeat(64),
  executionSurface: "sf_guardrail_bridge" as const,
  nativeBinarySha256: "d".repeat(64),
};
const bridgeProvenance: GuardrailBridgeProvenance = {
  exporterSha256: "e".repeat(64),
  provenanceSourceSha256: "f".repeat(64),
};
const rows = (split: "validation" | "test"): GuardrailEvaluationRecord[] =>
  GUARDRAIL_REQUIRED_FAMILIES.flatMap((family) =>
    [false, true].map((risky) => ({
      id: `${split}-${family}-${risky}`,
      groupId: `${split}-${family}-${risky}`,
      family,
      expected: risky ? (family === "files" ? "block" : "confirm") : "allow",
      baseline: risky ? (family === "files" ? "block" : "confirm") : "allow",
      actual: risky ? (family === "files" ? "block" : "confirm") : "allow",
      modelEligible: family !== "files",
      modelAnswered: family !== "files",
      policyFloor: family === "files",
      elapsedMs: 120,
      inputSha256: sha(`${split}-${family}-${risky}`),
      evidence: {
        source: family === "files" ? "exact_policy" : "jev",
        actual: risky ? (family === "files" ? "block" : "confirm") : "allow",
        prediction: risky ? "confirm" : "allow",
        inputSha256: sha(`${split}-${family}-${risky}`),
        modelSha256: identity.modelSha256,
        protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        allowScore: risky ? 0.01 : 0.999,
        elapsedMs: 120,
      },
    })),
  );
const inventory = (): GuardrailInventoryRecord[] => [
  {
    id: "train-original",
    groupId: "train-original",
    family: "shell",
    split: "train",
    expected: "allow",
    baseline: "allow",
    policyFloor: false,
    modelEligible: true,
    inputSha256: sha("train-original"),
  },
  ...(["validation", "test"] as const).flatMap((split) =>
    rows(split).map(
      ({ actual, modelAnswered, elapsedMs, evidence, ...row }) => ({
        ...row,
        split,
        inputSha256: row.inputSha256!,
      }),
    ),
  ),
];
const passing = (provenance = bridgeProvenance) => {
  const validation = qualifyGuardrail(rows("validation"), {
    ...identity,
    bridgeProvenance: provenance,
    split: "validation",
  });
  const freeze = freezeGuardrailCandidate(validation, inventory(), provenance);
  return qualifyGuardrail(rows("test"), {
    ...identity,
    bridgeProvenance: provenance,
    split: "test",
    freeze,
  });
};

// Run copied modules in a fresh process so their implementation fingerprint is
// recomputed. Only synthetic adapter scores and synthetic qualification rows
// are used; the copied runtime never opens a model or starts a native worker.
function checkIsolatedClient(
  directory: string,
  report?: GuardrailQualification,
) {
  const script = `
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const data = JSON.parse(readFileSync(0, "utf8"));
    const directory = process.argv[1];
    const load = (name) => import(pathToFileURL(directory + "/" + name + ".js").href);
    const [evaluation, backend, guardrail] = await Promise.all([
      load("guardrail-evaluation"), load("backend"), load("guardrail")
    ]);
    const adapter = {
      async warmup() {},
      async compile(plan) { return plan.questions; },
      async evaluate(branches) {
        return {
          logits: Object.fromEntries(branches.map((branch) => [
            branch.branch_id,
            Object.fromEntries(branch.output_labels.map((label, index) => [label, index === 0 ? 8 : -8]))
          ])),
          input_tokens: 1,
          metrics: {}
        };
      },
      async dispose() {}
    };
    const config = backend.configFromEnv({
      JEV_DEVICE: "cpu", JEV_MODEL_ID: "google/gemma-3-1b-it", JEV_TEMPLATE_VERSION: "v2"
    });
    const classifier = new backend.Classifier(config, adapter);
    const probe = await guardrail.classifyGuardrailRisk(classifier, {
      version: 1, toolName: "bash", input: { command: "ls" }, facts: {}
    }, config.modelId);
    await classifier.dispose();
    let report = data.report;
    if (!report) {
      const validation = evaluation.qualifyGuardrail(data.validation, { ...data.identity, bridgeProvenance: data.bridgeProvenance, split: "validation" });
      const freeze = evaluation.freezeGuardrailCandidate(validation, data.inventory, data.bridgeProvenance);
      report = evaluation.qualifyGuardrail(data.test, { ...data.identity, bridgeProvenance: data.bridgeProvenance, split: "test", freeze });
    }
    let freezeError, receiptError, validationFreezeError;
    try { evaluation.assertGuardrailFreeze(report.freeze, data.identity, data.inventory, data.bridgeProvenance); }
    catch (error) { freezeError = error.message; }
    try { evaluation.verifyGuardrailQualification(report, data.identity.modelSha256, data.identity.nativeBinarySha256); }
    catch (error) { receiptError = error.message; }
    try { evaluation.freezeGuardrailCandidate(report.freeze.validation, data.inventory, data.bridgeProvenance); }
    catch (error) { validationFreezeError = error.message; }
    process.stdout.write(JSON.stringify({
      report, probe, freezeError, receiptError, validationFreezeError,
      criteriaSha256: evaluation.GUARDRAIL_CRITERIA_SHA256,
      protocolSha256: guardrail.GUARDRAIL_PROTOCOL_SHA256
    }));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, directory],
      {
        input: JSON.stringify({
          identity,
          bridgeProvenance,
          inventory: inventory(),
          validation: rows("validation"),
          test: rows("test"),
          report,
        }),
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  ) as {
    report: GuardrailQualification;
    probe: { action: string };
    freezeError?: string;
    receiptError?: string;
    validationFreezeError?: string;
    criteriaSha256: string;
    protocolSha256: string;
  };
}

describe("frozen guardrail selection", () => {
  it("counts an authored incomplete request as explicit ineligible fallback without hiding eligible model failures", () => {
    const fallbackReason =
      "Incomplete Jev risk input: missing body or file for sf_apex log.analyze";
    const fallback: GuardrailEvaluationRecord = {
      id: "validation-apex-incomplete-synthetic",
      groupId: "validation-apex-incomplete-synthetic",
      family: "apex",
      expected: "allow",
      baseline: "allow",
      actual: "allow",
      modelEligible: false,
      modelAnswered: false,
      policyFloor: false,
      fallbackReason,
      inputSha256: sha(null),
      elapsedMs: 12,
      evidence: {
        source: "rules_fallback",
        actual: "allow",
        reason: fallbackReason,
        elapsedMs: 12,
      },
    };
    const report = qualifyGuardrail([...rows("validation"), fallback], {
      ...identity,
      bridgeProvenance,
      split: "validation",
    });
    expect(report.metrics.ineligibleFallbacks).toBe(1);
    expect(report.gates.integratedExecution).toBe(true);
    expect(report.gates.completeModelExecution).toBe(true);
    const { fallbackReason: _omittedReason, ...withoutFallbackReason } = fallback;
    const concealed = qualifyGuardrail(
      [
        ...rows("validation"),
        { ...withoutFallbackReason, modelEligible: true, modelAnswered: false },
      ],
      { ...identity, bridgeProvenance, split: "validation" },
    );
    expect(concealed.gates.completeModelExecution).toBe(false);
    const mismatched = qualifyGuardrail(
      [
        ...rows("validation"),
        {
          ...fallback,
          evidence: { ...fallback.evidence!, reason: "different" },
        },
      ],
      { ...identity, bridgeProvenance, split: "validation" },
    );
    expect(mismatched.gates.integratedExecution).toBe(false);
  });
  it("refuses to freeze validation from a different bridge exporter", () => {
    const validation = qualifyGuardrail(rows("validation"), {
      ...identity,
      bridgeProvenance,
      split: "validation",
    });
    expect(validation.bridgeProvenance).toEqual(bridgeProvenance);
    const changedProvenance = {
      ...bridgeProvenance,
      exporterSha256: "0".repeat(64),
    };
    expect(() =>
      freezeGuardrailCandidate(validation, inventory(), changedProvenance),
    ).toThrow("failed validation");
    expect(() =>
      freezeGuardrailCandidate(
        { ...validation, bridgeProvenance: changedProvenance },
        inventory(),
        changedProvenance,
      ),
    ).toThrow("Invalid, incomplete or overlapping frozen corpus inventory");
  });
  it("binds the bridge exporter source and rejects a changed file before held-out execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jev-bridge-exporter-"));
    const exporter = join(directory, GUARDRAIL_BRIDGE_EXPORTER_SOURCE);
    const bundlePath = join(directory, "baseline.json");
    const source = "// frozen bridge exporter\n";
    await mkdir(join(directory, "extensions/sf-guardrail/tests"), {
      recursive: true,
    });
    await writeFile(exporter, source);
    const sourceSha256 = {
      [GUARDRAIL_BRIDGE_EXPORTER_SOURCE]: createHash("sha256")
        .update(source)
        .digest("hex"),
    };
    const bundle = {
      sourceSha256,
      provenanceSourceSha256: createHash("sha256")
        .update(JSON.stringify(sourceSha256))
        .digest("hex"),
    };
    await writeFile(bundlePath, JSON.stringify(bundle));
    const provenance = guardrailBridgeProvenance(
      bundle,
      sourceSha256[GUARDRAIL_BRIDGE_EXPORTER_SOURCE],
    );
    const report = passing(provenance);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.stubEnv("GUARDRAIL_BASELINE_OUTPUT", bundlePath);
    try {
      expect(report.qualified).toBe(true);
      expect(() =>
        assertGuardrailFreeze(report.freeze, identity, inventory()),
      ).not.toThrow();
      await writeFile(exporter, "// changed bridge exporter\n");
      expect(() =>
        assertGuardrailFreeze(report.freeze, identity, inventory()),
      ).toThrow("Missing or changed guardrail bridge exporter provenance");
      expect(() =>
        assertGuardrailFreeze(report.freeze, identity, inventory(), {
          ...provenance,
          exporterSha256: "a".repeat(64),
        }),
      ).toThrow("held-out execution is prohibited");
      expect(() =>
        guardrailBridgeProvenance({
          ...bundle,
          provenanceSourceSha256: "0".repeat(64),
        }),
      ).toThrow("Missing or changed guardrail bridge exporter provenance");
    } finally {
      cwd.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("requires real bridge evidence, complete coverage and a frozen validation-selected candidate", () => {
    const test = qualifyGuardrail(rows("test"), { ...identity, split: "test" });
    expect(test.qualified).toBe(false);
    expect(passing().qualified).toBe(true);
    const direct = qualifyGuardrail(rows("validation"), {
      ...identity,
      bridgeProvenance,
      split: "validation",
      executionSurface: "direct_classifier",
    });
    expect(() =>
      freezeGuardrailCandidate(direct, inventory(), bridgeProvenance),
    ).toThrow("failed validation");
    const missingFamily = qualifyGuardrail(
      rows("validation").filter((r) => r.family !== "browser"),
      { ...identity, bridgeProvenance, split: "validation" },
    );
    expect(() =>
      freezeGuardrailCandidate(missingFamily, inventory(), bridgeProvenance),
    ).toThrow();
  });
  it("rejects unsafe allows, concealed fallback, extra interruptions, changed exact blocks and late completion", () => {
    for (const change of [
      (r: GuardrailEvaluationRecord) =>
        r.expected === "confirm" ? { ...r, actual: "allow" as const } : r,
      (r: GuardrailEvaluationRecord) =>
        r.expected === "allow" ? { ...r, actual: "confirm" as const } : r,
      (r: GuardrailEvaluationRecord) =>
        r.expected === "block" ? { ...r, actual: "confirm" as const } : r,
      (r: GuardrailEvaluationRecord) =>
        r.modelEligible ? { ...r, modelAnswered: false } : r,
      (r: GuardrailEvaluationRecord) =>
        r.modelEligible ? { ...r, error: "rules fallback", elapsedMs: 501 } : r,
    ]) {
      const report = passing();
      report.records = report.records.map(change);
      report.qualified = true;
      expect(() =>
        verifyGuardrailQualification(
          report,
          identity.modelSha256,
          identity.nativeBinarySha256,
        ),
      ).toThrow();
    }
  });
  it("detects report tampering, missing cases, edited gold, modified cutoffs and stale identities", () => {
    const original = passing();
    expect(
      verifyGuardrailQualification(
        original,
        identity.modelSha256,
        identity.nativeBinarySha256,
      ).protocolSha256,
    ).toBe(GUARDRAIL_PROTOCOL_SHA256);
    for (const report of [
      { ...original, records: original.records.slice(1) },
      {
        ...original,
        records: original.records.map((r, i) =>
          i === 0 ? { ...r, inputSha256: "d".repeat(64) } : r,
        ),
      },
      { ...original, freeze: { ...original.freeze!, minimumAllowScore: 0.5 } },
      {
        ...original,
        freeze: { ...original.freeze!, bridgeProvenance: undefined },
      },
      {
        ...original,
        freeze: { ...original.freeze!, version: 1 },
      },
      { ...original, protocolSha256: "d".repeat(64) },
      { ...original, executionSurface: "direct_classifier" },
    ])
      expect(() =>
        verifyGuardrailQualification(
          report,
          identity.modelSha256,
          identity.nativeBinarySha256,
        ),
      ).toThrow();
    expect(() =>
      verifyGuardrailQualification(
        original,
        "e".repeat(64),
        identity.nativeBinarySha256,
      ),
    ).toThrow();
  });
  it("rejects related groups and exact request contexts crossing splits", () => {
    const validation = qualifyGuardrail(rows("validation"), {
      ...identity,
      bridgeProvenance,
      split: "validation",
    });
    for (const field of ["groupId", "inputSha256"] as const) {
      const inv = inventory();
      inv[21] = { ...inv[21], [field]: inv[1][field] };
      expect(() =>
        freezeGuardrailCandidate(validation, inv, bridgeProvenance),
      ).toThrow("overlapping");
    }
  });
  it.each(["backend", "models", "guardrail-extension"])(
    "invalidates old validation, freeze and receipt when copied %s scoring-client bytes change",
    async (changedModule) => {
      const directory = await mkdtemp(
        join(tmpdir(), "jev-guardrail-client-binding-"),
      );
      try {
        await writeFile(join(directory, "package.json"), '{"type":"module"}');
        for (const name of [
          "guardrail-evaluation",
          "core",
          "guardrail",
          "backend",
          "models",
          "guardrail-extension",
        ]) {
          const source = await readFile(
            new URL(`../src/${name}.ts`, import.meta.url),
            "utf8",
          );
          const copied = ts.transpileModule(source, {
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ES2023,
            },
          }).outputText;
          await writeFile(join(directory, `${name}.js`), copied);
        }
        const before = checkIsolatedClient(directory);
        expect(before.report.qualified).toBe(true);
        expect(before.freezeError).toBeUndefined();
        expect(before.receiptError).toBeUndefined();
        expect(before.validationFreezeError).toBeUndefined();
        expect(before.probe.action).toBe("allow");
        const path = join(directory, `${changedModule}.js`);
        const original = await readFile(path, "utf8");
        if (changedModule === "backend") {
          // Reproduce an actual client mapping change with the same prompts,
          // model/native binary identity and synthetic native logits.
          expect(original).toContain("result.logits,");
          await writeFile(
            path,
            original.replace(
              "result.logits,",
              "Object.fromEntries(Object.entries(result.logits).map(([id, row]) => [id, Object.fromEntries(Object.entries(row).map(([label, logit]) => [label, -logit]))])),",
            ),
          );
        } else {
          await writeFile(
            path,
            original + "\n// Revised copied scoring client module.\n",
          );
        }
        const after = checkIsolatedClient(directory, before.report);
        expect(after.probe.action).toBe(
          changedModule === "backend" ? "confirm" : "allow",
        );
        expect(after.protocolSha256).toBe(before.protocolSha256);
        expect(after.report.modelSha256).toBe(before.report.modelSha256);
        expect(after.report.nativeBinarySha256).toBe(
          before.report.nativeBinarySha256,
        );
        expect(after.criteriaSha256).not.toBe(before.criteriaSha256);
        expect(after.freezeError).toContain("held-out execution is prohibited");
        expect(after.receiptError).toBeDefined();
        expect(after.validationFreezeError).toBeDefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
