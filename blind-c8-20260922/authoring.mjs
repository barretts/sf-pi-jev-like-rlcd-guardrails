import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const directory = dirname(fileURLToPath(import.meta.url));
export const rubric = "fixtures/guardrail/RUBRIC.md";
export const hostContract = "integrations/sf-pi-guardrail/candidate7-sf-pi-from-4f901db9.patch";
export const sourceForLane = {
  shell: "src/guardrail.ts",
  herdr_pane: "src/guardrail.ts",
  salesforce_cli: "src/guardrail.ts",
  apex: "src/guardrail.ts",
  agentscript: "src/guardrail.ts",
  data360: "src/guardrail.ts",
  soql: "src/guardrail.ts",
  canvas: "src/guardrail.ts",
  browser: "src/guardrail.ts",
};

export function allow(tool, input, reasonCode, rationale, fixture = {}) {
  return { tool, input, expected: { decision: "allow", reason_code: reasonCode, rationale }, fixture };
}
export function confirm(tool, input, reasonCode, rationale, fixture = {}) {
  return { tool, input, expected: { decision: "require_approval", reason_code: reasonCode, rationale }, fixture };
}

export function org(alias, type, command) {
  return {
    observations: { org: { alias, type, guessed: false, ...(command ? { command } : {}) } },
    facts: [`Independent host observation resolves ${alias} as ${type}.`],
  };
}
export function unknownOrg(alias) {
  return { facts: [`${alias} is only a requested target; no independent org type is available.`] };
}
export function click(label, reason, page, options = {}) {
  return {
    tool: "sf_browser_click",
    input: { reason, ...(options.mutation === undefined ? {} : { mutation: options.mutation }) },
    browser: {
      label,
      page,
      status: options.status ?? "fresh",
      role: options.role ?? "button",
      snapshotContext: options.snapshotContext ?? "",
    },
  };
}

function mergeFixture(base, special, operation) {
  const facts = [
    `Requested operation is evaluated from /workspace/c8-${base.split}.`,
    ...(operation.facts ?? []),
    ...(special.facts ?? []),
  ];
  const observations = { ...(special.observations ?? {}) };
  return {
    cwd: `/workspace/c8-${base.split}`,
    facts,
    ...(Object.keys(observations).length ? { observations } : {}),
  };
}

export function makeCorpus(split, definitions) {
  if (!["valid", "test"].includes(split)) throw new Error("Invalid split");
  const cases = [];
  const groupIds = new Set();
  for (const { lane, slug, safe, risky } of definitions) {
    if (!sourceForLane[lane] || !/^[a-z0-9-]+$/.test(slug)) throw new Error("Invalid lane or slug");
    const groupId = `c8-${split}-${lane}-${slug}`;
    if (groupIds.has(groupId)) throw new Error(`Duplicate group ${groupId}`);
    groupIds.add(groupId);
    for (const [variant, spec] of [["safe", safe], ["risky", risky]]) {
      if (spec.expected.decision !== (variant === "safe" ? "allow" : "require_approval"))
        throw new Error(`Wrong decision for ${groupId}/${variant}`);
      const ordinal = cases.length + 1;
      const id = `c8-${split}-${String(ordinal).padStart(3, "0")}`;
      const operation = { tool: spec.tool, input: { ...spec.input } };
      const fixture = mergeFixture({ split }, spec.fixture, spec);
      if (spec.browser) {
        const ref = `e${(split === "valid" ? 100 : 500) + ordinal}`;
        operation.input.ref = ref;
        const { label, role, status, page, snapshotContext } = spec.browser;
        if (status === "fresh") {
          const snapshot = `${snapshotContext}- ${role} "${label}" ref=${ref}\n`;
          const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
          fixture.observations = {
            ...(fixture.observations ?? {}),
            browserRef: { status, label, role, snapshotSha256 },
            browserPage: { status: "fresh", url: page, snapshotSha256, snapshot },
          };
          fixture.facts.push("The host observed this labeled reference in the latest page snapshot.");
        } else {
          fixture.observations = {
            ...(fixture.observations ?? {}),
            browserRef: { status, label, role },
          };
          fixture.facts.push(`The browser reference is ${status}; no fresh page binding is available.`);
        }
      }
      cases.push({
        id,
        family: lane,
        group_id: groupId,
        template_id: `${groupId}-${variant}`,
        fixture,
        operation,
        expected: spec.expected,
        sources: [rubric, hostContract, sourceForLane[lane]],
      });
    }
  }
  return { schema_version: "c8.1", split, cases };
}

export async function writeCorpus(split, definitions) {
  const corpus = makeCorpus(split, definitions);
  await writeFile(resolve(directory, `${split}.json`), `${JSON.stringify(corpus, null, 2)}\n`);
  return corpus;
}
