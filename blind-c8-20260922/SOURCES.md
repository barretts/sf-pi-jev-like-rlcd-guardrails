# Candidate 8 source notes

The [operation-policy rubric](../fixtures/guardrail/RUBRIC.md) is the gold-label
authority. The [Jev risk interface](../src/guardrail.ts) defines the semantic
families and the 32 KiB request-input limit. The
[C7 sf-pi integration patch](../integrations/sf-pi-guardrail/candidate7-sf-pi-from-4f901db9.patch)
defines the host tool boundary and policy floors. Candidate 8 checks current
host routing separately; neither the host's rule action nor any model output
was used to assign a label.

The tool-specific input shapes were checked against sf-pi at commit
`bc7862b078997d2c60aa908979b5cbf59f83db80`: `extensions/sf-apex/lib/sf-apex-tool.ts`,
`extensions/sf-agentscript/lib/lifecycle-tool.ts`,
`extensions/sf-soql/lib/sf-soql-tool.ts`,
`extensions/sf-slack/lib/canvas-tool.ts`,
`extensions/sf-data360/lib/v2/tools.ts`,
`extensions/sf-data360/registry/v2/actions.json`,
`extensions/sf-browser/lib/sf_browser_click-tool.ts`, and
`lib/common/sf-browser-snapshot-state.ts`. Exact protected-file behavior is
specified by `extensions/sf-guardrail/SF_GUARDRAIL_DEFAULTS.json` and
`extensions/sf-guardrail/lib/rule-behavior.ts` at that same host commit.

The current model-free VALID routing replay uses sf-pi's preimplemented
fail-closed C8 host commit `bdbf6292f383a8b2e12cd236aafb2be9c335f463`
and a clean build of Jev runtime commit
`b65f981696316856a9dc67244be76f679b00a575`. Its receipt records the
host baseline, the C8 base decision protocol, the unchanged scorer prompt,
compiled runtime hashes, and each original-operation hash. The earlier
shadow-host replay at `d86cdcfcfa02e419a4255291d16e56c48a5f2ade` is
preserved in version history. The replay checks eligibility and input
preparation only; it supplies no label authority or model score.

The browser rubric allows a fresh observed navigation ref with an ordinary
inspection reason. Case 085 uses a fresh `Contacts` link on a Contact detail
page; its prior `Filter` button was replaced because the label alone did not
establish a read-only click effect. The correction was made before any real
C8 VALID score.

Official command and API references corroborate the shell-mediated cases:

- [Salesforce data command snapshot](https://github.com/salesforcecli/plugin-data/blob/main/command-snapshot.json)
  documents the `data upsert bulk` target, file, object, and external-ID flags.
- [Salesforce deploy command snapshot](https://github.com/salesforcecli/plugin-deploy-retrieve/blob/main/command-snapshot.json)
  documents deploy preview, validate, and start command shapes.
- [Slack Canvas edit](https://docs.slack.dev/reference/methods/canvases.edit/),
  [delete](https://docs.slack.dev/reference/methods/canvases.delete/), and
  [section lookup](https://docs.slack.dev/reference/methods/canvases.sections.lookup/)
  distinguish content mutations from section reads.

These references establish operation shapes and intended effects, not live
credentials, remote resource existence, Salesforce org state, or human label
approval. All IDs, org aliases, domains, and page snapshots are synthetic.
