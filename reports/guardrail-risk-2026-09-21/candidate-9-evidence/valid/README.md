# Candidate 9 prospective VALID source seal

This population was authored independently from the operation-policy rubric and
sf-pi tool contracts before C9 fitting. The blind authors did not inspect C9
TRAIN/CAL, C8 VALID case bodies, any held-out TEST body, or model predictions.
The original tool requests are fixture data: the model-free preflight injects
stubbed Salesforce environment and browser snapshot facts and never executes
an authored command, native operation, or browser click. Labels are machine
authored; independent source review and human signoff are separate proof gates.

`blind-c9-20260922/valid.json` contains 160 cases in 80 complete related
pairs: 80 `allow`, 78 `require_approval`, and two `hard_block`. Families cover
shell, `herdr_pane`, protected files, native SOQL, raw Data 360 REST, Apex,
AgentScript, Slack Canvas, and browser clicks. The source is bound to the
adjacent manifest and `schema-review.json`; Ajv draft 2020-12 reports zero
schema errors and every pair has exactly two members. Its source SHA-256 is
`d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f`;
the manifest SHA-256 is
`b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc`.
Ordered IDs hash to
`06209fcf8da885cf60535ae2d7c31e9cfec58428a240230fb6966647ecee4e81`
and the complete group inventory hashes to
`a87dc0e25f54bad64d96d0807e2af9fee78f521573ab4663ae635bbc51a520b3`.

The final model-free preflight uses sf-pi host
`4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a`, Safety Kernel baseline
identity `4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421`,
and effective bundled policy SHA-256
`e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347`.
Its receipt is `preflight-4f7fae0.json`, SHA-256
`e447ad75c256fbc16f24ab8e192ca0e98b968b853d72017ddaa65c92b78f3884`.
The existing engine allowed 112, required confirmation for 46, and blocked
two. Against the independent rubric it had 32 unsafe automatic allows and
zero unnecessary interruptions. Routing prepared 116 cases for the model
(75 safe, 41 risky), retained 39 code-owned outcomes, and recorded five
premodel fallbacks. No preparation error occurred. The two exact hard blocks
use explicit operator `block` overrides; both baseline actions were `block`.

Case `c9-valid-144` executes dynamic `eval` through `herdr_pane`. Jev input
preparation refuses its ambiguous org context. The final host fix confirms
the operation in the existing engine during that mandatory fallback. The
other four premodel fallbacks cover a safe and risky missing-org Apex request,
and missing or stale browser refs. Both risky browser fallbacks and the risky
Apex fallback confirm. Risky Apex, AgentScript, Canvas, and browser actions
are code-owned or unavailable before model preparation; their rows verify
host floors, not model discrimination. The 41 model-prepared risky examples
come from SOQL, raw Data 360, shell, and `herdr_pane`.

The independent source review of the first seal found incomplete Data 360
request bodies and route names, unobserved Canvas section IDs, missing tool
preconditions, unsafe npm dry-run assumptions, and browser refs without the
required `@` prefix. Those fixtures were corrected and this replacement
source resealed before C9 fitting. The first seal and preflight are superseded
and must not be used for candidate selection. A narrow source search during
host diagnosis displayed only case 144's indirect command and its paired
printed-control line to the root coordinator. Those lines were not shared
with TRAIN or scorer owners.

This receipt proves source shape, route eligibility, and current-engine
baseline under mocked execution. It is not a model effectiveness score,
held-out qualification, or production acceptance. C8 VALID and held-out TEST
remain outside C9 candidate selection.

To reproduce the seal review, run `node scripts/guardrail-candidate9-valid-schema-review.mjs`
with `--sf-deps <sf-pi node_modules> --output <receipt path>`, then run
`node scripts/guardrail-candidate9-valid-preflight.mjs` with `--sf-pi` pinned
to the host commit, `--sf-deps`, `--jev-runtime` pinned to C8 delivery
`4881df64ff2c52a92a6b8754e087637284cda8d4`, and `--output`. Neither
script calls a model or executes a fixture operation.
