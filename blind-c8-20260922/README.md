# Candidate 8 blind guardrail corpus

Candidate 8 uses a new, group-disjoint operation-policy split. The VALID file is
available for candidate selection. The held-out TEST file is reserved until the
model, scoring protocol, cutoff, and qualification gates are frozen. Authors did
not inspect prior TRAIN/VALID cases, any prior held-out TEST file, or Candidate 7
model score receipts. Labels were assigned from the explicit policy rubric,
before any model or current host result. Human label review remains pending.

The split has nine semantic lanes: shell, `herdr_pane.run`, Salesforce org/CLI,
Anonymous Apex, AgentScript lifecycle, Data 360, SOQL, Slack Canvas, and
Salesforce browser clicks. Each semantic lane contributes five independently
named operation groups per split. Three extra exact-policy groups per split
test configured hard blocks and safe carve-outs. A group contains a safe and
risky contrast; all
related variants stay within that split. Every case supplies the complete
requested tool operation, explicit expected decision and rationale, source
references, and independently supplied host facts when org or browser identity
matters. The cases use only synthetic names, IDs, and domains, and no operation
is executed by corpus generation or integrity tests.

Source basis:

- [`RUBRIC.md`](../fixtures/guardrail/RUBRIC.md) is the operation-policy label
  authority. It distinguishes quoted data from execution, reads and real dry
  runs from durable effects, independently observed org/browser facts from
  claims, and exact host-owned policy from model judgment.
- [`guardrail.ts`](../src/guardrail.ts) defines the semantic families and risk
  input contract.
- [`candidate7-sf-pi-from-4f901db9.patch`](../integrations/sf-pi-guardrail/candidate7-sf-pi-from-4f901db9.patch)
  defines the pinned C7 host eligibility, policy floors, and native input
  completeness contract that Candidate 8 probes. It is not a label source.
- The tool-specific shapes were crosschecked against the sf-pi tool schemas and
  Data 360 action catalog. The corpus's `sources` field records the pinned
  repository basis for each row.

`case.schema.json` describes the exported JSON. `valid.source.mjs` and
`test.source.mjs` are the authored operation sources; `authoring.mjs` only
expands the pair definitions, independent facts, IDs, and browser snapshot
fingerprints. The TEST generator and full seal audit require the explicit
`C8_TEST_SEAL_AUDIT=1` author gate. The
manifest pins exact schema and split bytes and publishes aggregate TEST counts
and hashes without revealing TEST group or template IDs. A VALID-only commit
precedes the sealed TEST commit so the trainer can receive VALID without TEST.

The integrity tests verify syntax, required fields, labels, duplicate requests,
two-case group composition, group and template separation across splits,
manifest seals, and source reproduction. Tests do not invoke tools, models,
Salesforce, Slack, or a browser. The optional host preflight uses mocked org and
browser facts, keeps enforcement off, and processes VALID only. A green
preflight establishes routing and input preparation, not live operation safety
or a model result. `valid-host-preflight.json` pins every VALID case's baseline
action, routing lane, and model-visible risk-input SHA-256 where one was
prepared. It also pins the host baseline, Jev runtime and compiled bytes, the
scorer prompt, and C8 base decision protocol identities. The final
model-specific scoring protocol is selected separately from TRAIN calibration.
The
source and correction history is in `HISTORY.md`.
