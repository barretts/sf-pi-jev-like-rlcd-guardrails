import { describe, expect, it } from "vitest";
import { guardrailRequest } from "../dist/guardrail.js";
import {
  applyCandidate6Corrections,
  CORRECTIONS,
  REST_CONTACT_REPAIRS,
  screenCrossSplitOperations,
  WITHHELD_TRAIN_GROUPS,
} from "../scripts/guardrail-candidate6-corrections.mjs";

const model = "google/gemma-3-1b-it";

function row(
  id: string,
  group: string,
  split: "train" | "validation",
  command: string,
  label: "allow" | "confirm",
  orgType?: string,
  pane = false,
) {
  const state = {
    version: 2 as const,
    toolName: pane ? "herdr_pane" : "bash",
    input: pane
      ? { command, action: "run", pane: "guardrail-rehearsal" }
      : { command },
    facts: orgType
      ? { orgs: [{ type: orgType, guessed: false, command }] }
      : {},
  };
  return {
    id,
    group_id: group,
    split,
    request: guardrailRequest(state, model),
    targets: { risk: { answer: label } },
    target_provenance: { risk: { source: "supplied" } },
  };
}

function c5Rows() {
  const rows: ReturnType<typeof row>[] = [];
  for (const correction of CORRECTIONS) {
    for (let variant = 1; variant <= 3; variant++) {
      const command =
        variant === 2 ? `env LC_ALL=C ${correction.before}` : correction.before;
      rows.push(
        row(
          `${correction.sourceGroup}-v${variant}`,
          correction.sourceGroup,
          correction.split as "train" | "validation",
          command,
          correction.label as "allow" | "confirm",
          correction.orgType,
          variant === 3,
        ),
      );
    }
  }
  for (const group of WITHHELD_TRAIN_GROUPS) {
    for (let variant = 1; variant <= 3; variant++)
      rows.push(
        row(
          `${group}-v${variant}`,
          group,
          "train",
          `printf 'withheld-${group}-${variant}'`,
          "confirm",
        ),
      );
  }
  for (const repair of REST_CONTACT_REPAIRS)
    rows.push(
      row(
        repair.id,
        "c5-soql-proposal-rest-sample-vs-contact-disclosure",
        "train",
        `sf api request rest 'services/data/v66.0/query/?q=${repair.query}' --method GET --target-org DevOrg`,
        repair.label as "allow" | "confirm",
        "sandbox",
      ),
    );
  for (let i = 0; i < 149; i++)
    rows.push(
      row(
        `train-filler-${i}`,
        `train-filler-group-${i}`,
        "train",
        `pwd # ${i}`,
        "allow",
      ),
    );
  for (let i = 0; i < 84; i++)
    rows.push(
      row(
        `validation-filler-${i}`,
        `validation-filler-group-${i}`,
        "validation",
        `git status --short # ${i}`,
        "allow",
      ),
    );
  return rows;
}

describe("Candidate 6 source-valid development correction", () => {
  it("rebuilds complete requests, synchronizes org facts, and withholds near replays", () => {
    const source = c5Rows();
    const original = structuredClone(source);
    const result = applyCandidate6Corrections(source);
    expect(result).toMatchObject({ train: 158, validation: 96 });
    expect(result.rows).toHaveLength(254);
    expect(result.collisionScreen.disjointProven).toBe(false);
    expect(source).toEqual(original);
    for (const correction of CORRECTIONS) {
      const rows = result.rows.filter(
        (item) => item.group_id === correction.targetGroup,
      );
      expect(rows).toHaveLength(3);
      for (const item of rows) {
        const state = item.request.state as {
          input: { command: string };
          facts: { orgs: Array<{ command: string }> };
        };
        expect(state.input.command).toContain(correction.after);
        expect(state.facts.orgs[0].command).toBe(state.input.command);
        expect(item.request).toEqual(guardrailRequest(state, model));
      }
    }
    for (const repair of REST_CONTACT_REPAIRS) {
      const updated = result.rows.find((item) => item.id === repair.id);
      expect(updated).toBeDefined();
      const state = updated?.request.state as {
        input: { command: string };
        facts: { orgs: Array<{ command: string }> };
      };
      expect(state.input.command).toContain(`/query?q=${repair.query}`);
      expect(state.input.command).not.toContain("/query/?q=");
      expect(state.facts.orgs[0].command).toBe(state.input.command);
      expect(updated?.request).toEqual(guardrailRequest(state, model));
    }
    expect(
      result.rows.some((item) => WITHHELD_TRAIN_GROUPS.includes(item.group_id)),
    ).toBe(false);
    expect(
      result.rows.some((item) =>
        /001EXAMPLE|--job-id EXAMPLE|sf org generate password -o ProdOrg/.test(
          (item.request.state as { input: { command?: string } }).input
            .command ?? "",
        ),
      ),
    ).toBe(false);
  });

  it("rejects undeclared record and deploy-job preconditions", () => {
    const source = c5Rows();
    const badId = CORRECTIONS.map((item) =>
      item.fixture.kind === "existing-record-id"
        ? { ...item, fixture: { ...item.fixture, id: "001EXAMPLE" } }
        : item,
    );
    expect(() => applyCandidate6Corrections(source, badId)).toThrow(
      "Invalid or unverified record-ID fixture",
    );
    const staleJob = CORRECTIONS.map((item) =>
      item.fixture.kind === "recent-deploy-job"
        ? { ...item, fixture: { ...item.fixture, maximumAgeHours: 96 } }
        : item,
    );
    expect(() => applyCandidate6Corrections(source, staleJob)).toThrow(
      "Unverified deploy-job fixture",
    );
  });

  it("refuses TEST before reading any TEST request or label", () => {
    const source = c5Rows();
    const heldOut = { split: "test" } as (typeof source)[number];
    Object.defineProperty(heldOut, "request", {
      get: () => {
        throw new Error("TEST request was inspected");
      },
    });
    source[0] = heldOut;
    expect(() => applyCandidate6Corrections(source)).toThrow(
      "refuses held-out TEST",
    );
    expect(() => screenCrossSplitOperations([heldOut])).toThrow(
      "refuses held-out TEST",
    );
  });

  it("reports same-template and same-effect overlaps without exposing requests", () => {
    function soql(id: string, split: "train" | "validation", query: string) {
      const state = {
        version: 2 as const,
        toolName: "sf_soql",
        input: {
          action: "query.run",
          target_org: "DevOrg",
          query,
          max_rows: 2000,
        },
        facts: { orgs: [{ type: "sandbox", guessed: false }] },
      };
      return {
        id,
        group_id: id,
        split,
        request: guardrailRequest(state, model),
      };
    }
    const result = screenCrossSplitOperations([
      soql("bounded-train", "train", "SELECT Id FROM Account LIMIT 10"),
      soql("broad-valid", "validation", "SELECT Id, Email, Phone FROM Lead"),
      soql("bounded-valid", "validation", "SELECT Id FROM Case LIMIT 5"),
    ]);
    expect(result.templateOverlaps).toEqual([
      { template: "sf_soql:query.run", trainGroups: 1, validationGroups: 2 },
    ]);
    expect(result.sameEffectCollisions).toEqual([
      {
        template: "sf_soql:query.run",
        effect: "ordinary-soql-read",
        trainGroups: 1,
        validationGroups: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("SELECT");
  });

  it("rejects changed C5 row shape and missing corrected variants", () => {
    const source = c5Rows();
    source[0].request.state.input.command = "sf org list";
    expect(() => applyCandidate6Corrections(source)).toThrow(
      "C5 source changed for train-salesforce-sandbox-data-update",
    );
    const missing = c5Rows();
    missing.splice(0, 1);
    missing.push(row("extra", "extra", "train", "pwd # extra", "allow"));
    expect(() => applyCandidate6Corrections(missing)).toThrow(
      "Expected exactly three C5 variants",
    );
  });
});
