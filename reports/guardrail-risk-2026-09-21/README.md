# Guardrail risk replacement evidence, 2026-09-21

This report separates source/interface proof, actual Pi SDK execution with mocks,
RFDT training, native candidate qualification and production acceptance. The
candidate 2 is **rejected and unqualified**. Its real native SF bridge validation
completed with zero unsafe allows and warm p95 208.353 ms, but produced 75
unnecessary interruptions versus three for the baseline. This fails the
equal-or-better usability requirement. Optimizer updates, checkpoint checks,
exact adapter reload and separate F16 export completed. No improvement,
held-out qualification or production acceptance claim is made here.

The isolated worktrees use `barretts/jev-guardrail-risk`: Jev at
`/private/tmp/simple-jev-ts-guardrail-risk-20260921`, based on `95c0b50`, and sf-pi
at `/private/tmp/sf-pi-guardrail-risk-20260921`, based on `4f901db9`. The default
general classifier remains unchanged. The separate guardrail candidate uses
`google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752` and the existing
RFDT pipeline. No excluded model lineage, derivative, teacher or fallback is
introduced.

The SF integration's final local source checkpoint is
`388990554479450d223dbc4448eb80179246ef2f`; it has not been pushed. Its tree is
`944cee65cd156f11afa96dde179388f4d06b70e3`. The
[baseline-bound integration patch](../../integrations/sf-pi-guardrail/0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch)
retains its filename and contains four email patches: initial integration
`beaa11c0`, workflow proof `24546444`, ADR0052 clarification `eab0eac6`, and
semantic-call completeness checks at the final checkpoint above.
Its SHA-256 is `a523d5de1648b675adfeea650480a7e0c82c4ac6929c78b9788ad9a3f2e493e1`,
with 165,300 bytes. Splitting and sequentially applying all four to baseline
`4f901db9c3f5076ea0305dea33ad6e8856e467da` in a separate temporary index
reproduced the final tree. The real checkout/index remained unchanged. Runtime
baseline SHA-256 stays `0f31a95043fc761347a9ccc51dc673b6aaea77d9ca61bd129f789eaa51fa1f45`.
This proves patch delivery integrity; it does not activate a Pi host or publish
the integration.

The [operation-policy rubric](../../fixtures/guardrail/RUBRIC.md) supplies gold
independently of the current engine. Labels are machine authored from inspected
public implementation; human review remains pending. The
[corpus](../../fixtures/guardrail/corpus.json) contains 612 cases in 204 groups:

| Split         | All cases | Eligible semantic calls | Passed to RFDT training preparation |
| ------------- | --------: | ----------------------: | ----------------------------------- |
| Train         |       285 |                     252 | Yes                                 |
| Validation    |       165 |                     144 | Yes, as a separate validation split |
| Held-out test |       162 |                     141 | No; prepared test file is empty     |

Related variants stay in one operation group and split. Static checks require
shell, Herdr, file policy, Salesforce, Apex, AgentScript, Data 360, SOQL, Canvas
and browser coverage. Every semantic family contains safe and risky cases in
each split; exact-policy block cases are retained separately. Data 360 requests
include source-catalog required keys, with manual REST/readiness dispatcher
actions checked separately.

The corpus SHA-256 is
`f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2`.
The actual baseline kernel, using generic mocked host facts and no tool
execution, produced 30 unsafe allows and 17 unnecessary interruptions: 47
disagreements with the fixed gold rubric. All exact-policy floor outputs matched
gold. These numbers describe this finite authored corpus only.

| Candidate   | Observed training status                                                                                                                                  | Selection/qualification                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Candidate 1 | Stopped at update 42/256 after review found two incomplete Data 360 rehearsal parameter sets. The old corpus, plan and abandonment receipt are preserved. | Abandoned; no held-out model calls.                                                              |
| Candidate 2 | Fresh pinned Google base; corrected corpus; all 256 planned updates and checkpoint/reload checks completed. Separate F16 export recorded.                 | Native validation complete; rejected by usability gate; no prospective freeze or held-out calls. |

Candidate 2's training loss decreased from 4.7091871897 to 0.6262149849; the
adapter changed and reload maximum probability delta was zero. Training-phase
duration was 954.204 seconds. The worker checked rendered prompt tokens and
answer-label boundaries on 396 train/validation rows and 792 labels. The export
receipt identifies `jev/gemma-3-1b-guardrail-candidate-2`, SHA-256
`b67734870cc03c0b34ece18d00dc55b5b0c9686fe211635aed81f61ebc4cbc17`,
2,006,573,408 bytes. Learning, checkpoint reload and export integrity remain
separate from native bridge qualification.

The [complete native bridge validation receipt](./sf-bridge-validation.json)
contains all 165 validation records across 55 groups, with original case IDs,
input hashes and comparison evidence. All 144 eligible calls completed through
the real SF bridge/local Jev worker; no requested dangerous tool executed and no
fallback concealed a model failure. The independent host facts remain authored
fixtures.

| Validation criterion        | Candidate 2 | Baseline / requirement         | Result   |
| --------------------------- | ----------: | ------------------------------ | -------- |
| Unsafe automatic allows     |           0 | Baseline 14; required 0        | Pass     |
| Existing safety regressions |           0 | Required 0                     | Pass     |
| Exact hard-block demotions  |           0 | Required 0                     | Pass     |
| Unnecessary interruptions   |          75 | Baseline 3; required at most 3 | **Fail** |
| Warm risk-check p95, ms     |  208.353333 | Required at most 500           | Pass     |
| Eligible calls answered     |   144 / 144 | Every eligible call            | Pass     |
| Execution errors/fallbacks  |           0 | Required 0                     | Pass     |

Cold initialization was 2,548.651041 ms and is excluded from the warm latency
distribution. The measurement SHA-256 is
`beaee8cffff9d525abaf036a75fa51c55c4e8d8963542b353fbf1b255360c09b`;
native executable SHA-256 is
`7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96`.
Its final runtime baseline SHA-256 is
`0f31a95043fc761347a9ccc51dc673b6aaea77d9ca61bd129f789eaa51fa1f45`.
The rejection receipt remains under the candidate's ignored run directory.
No candidate freeze was created and no held-out model inference occurred.

The separate 18-case TRAIN-only overfit diagnosis completed 256 updates fixed
in advance, with zero validation/test branches. It classified all 18 cases
correctly by argmax, automatically allowed all nine safe cases at the unchanged
0.99 cutoff, and automatically allowed none of the nine risky cases. All 18
correct-class margins exceeded ln(99). Mean cross-entropy decreased from
4.04255549 to 0.0000245306. The minimum safe allow-minus-confirm margin was
8.8125; the maximum risky margin was -9.9375. Adapter reload probability delta
was zero and the original base remained unchanged.

The [complete TRAIN diagnostic receipt](./train-overfit-diagnostic.json)
contains all 18 generic authored cases. Its source report SHA-256 is
`f3a804333d4fbf3638da590e16cc92a9866eb90be60014235d0452421935b711`, bound to
prospective plan SHA-256
`c2328cc3aac616865903db854edb9729f4c8c6c3d961744b1d66757e520fd71a`.
The ledger separately records the compact tracked copy's hash. Root
independently recomputed the probability flags and checked those identities.
The result establishes memorization and behavior of the unchanged learning
pipeline on those TRAIN cases only. No validation/test evaluation, export,
promotion or workflow effectiveness is inferred. The rubric and qualification
gates remain unchanged; candidate 2's rejection is preserved.

Candidate 3's preparation completed at 00:08:08.433 UTC on 2026-09-22 and
verified 252 TRAIN / 144 validation / zero test branches. Its original-base
training started at 00:08:08.435 UTC, after disposal of the native preparation
worker. It retains the same inputs and profile, changing fixed updates from
256 to 1,536. The prospective training plan at
`.build/guardrail/candidate-3/prospective-plan.json` has SHA-256
`60c50c1c21930ad233f489fce5d7deb98e8caaff2e2302d046c6651c72f736dc`.
The owner journal and worker progress confirm training is in progress.
Completion and full TRAIN per-case post-fit evaluation are pending before any
export. Training, validation, held-out and matched workflow results remain
unset; selection and qualification still require the unchanged gates.

The saved-scalar CPU parity receipt
`.build/guardrail/candidate-3/initial-256-parity-receipt.json`, observed at
00:34:05.856 UTC, has SHA-256
`40065c9ce5dc8a2163a3d88073467a1870b40bb6a00e28a9832aaa11371f2e67`.
Its first 256 candidate 3 step IDs and TRAIN batch losses match candidate 2
256/256 exactly; maximum absolute loss difference is zero. Authored and
prepared TRAIN input hashes match. An independent CPU replay checked those
scalars and all seven bound plan/input hashes, without model calls or held-out
data. This supports reproducibility of the unchanged training profile only;
candidate 3's completion and all effectiveness results remain pending.

Candidate 2's preparation binds the original bundle SHA-256
`6381f6dc8c94de22105a417d95265a90ec798a3c36d18784f61a1c04c06dbc83` and its then-current
baseline/provenance SHA-256
`0db5db3546345a9058451450ed4f6eb4e3472944bcc2be367743f82dc99f720c`.
Later SF hardening separates runtime baseline identity from full exporter
provenance. A final bridge evaluation/freeze must use the final runtime identity;
the preparation identity is retained as history rather than overwritten.

Source tests cover provider discovery, strict input/response checks, failure
fallback, cancellation, qualification tampering, changed identities, worker
lifecycle and approval behavior. Final Jev source checks passed 1,011 tests
across 46 files in 10.44 seconds with isolated Pi state and narrowly escalated
local fixture listeners. TypeScript/package checks, build, 38 focused guardrail
tests across four files and formatting also passed. SF guardrail/runtime checks
passed 315 tests (one further test skipped), and six actual Pi SDK tests passed.
SF lint, docs build and validation stages before the full-suite stage passed.
Every SF test file was exercised in the appropriate isolated environment:

| SF test partition         | Observed result                        | Environment / boundary                                                                                                                                  |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broad suite, 593 files    | 4,214 passed / one failed / 40 skipped | Logging disabled, ordinary agent-directory environment, `NO_COLOR` unset. Only failure was an unrelated AgentScript dynamic-import five-second timeout. |
| Timeout replay            | Four tests passed in 2.27 s            | Affected file alone after other checks stopped; three passes overlap the broad run.                                                                     |
| Six state-sensitive files | 70 tests passed                        | Isolated Pi agent directory; user global state preserved.                                                                                               |
| Two localhost files       | Eight tests passed                     | Narrowly escalated local fixtures; no global-state writes or external operations.                                                                       |

This partition/replay coverage does not establish a successful uniform
`npm test` or `validate:ci` command. Earlier uniform sandbox attempts reported
4,273 passes / 20 failures / 40 skips / nine errors with the agent-directory
environment unset, and 4,227 passes / 66 failures / 40 skips / eight errors with
a forced isolated directory. Fixtures bind HOME/agent-directory state;
`NO_COLOR`, blocked global SF log writes and localhost `EPERM` also affected
those attempts. Partition results are not summed into a unique grand total.

The repeated package dry run passed with 171 files, 6,194,598 unpacked bytes and
1,280,112 tarball bytes after the workflow patch and setup guide update. It used
a worktree-local npm cache. Required guardrail sources, corpus, scripts and patch
were included; weights were excluded. These measurements precede recording the
observed sizes and do not identify a sealed final archive.
Source, package and patch checks do not qualify the local model.

The earlier two-operation SDK workflow exercises `AgentSession.prompt` and `ExtensionRunner`
with scripted inference and counter-only custom tools:

| Mode   | Accepted requests | Confirmations | Session grants | Retries | Errors | SDK setup ms | Workflow ms | Total ms |
| ------ | ----------------: | ------------: | -------------: | ------: | -----: | -----------: | ----------: | -------: |
| Off    |                 2 |             1 |              1 |       0 |      0 |        4.420 |       1.425 |    5.845 |
| Shadow |                 2 |             1 |              1 |       0 |      0 |        2.660 |       3.135 |    5.795 |

The SDK setup time is not model cold initialization. A separate real-hook stub
workflow accepted all three operations with two confirmations and zero retries
in each of `off`, `shadow` and `enforce`; its observed elapsed times were 1.152,
5.250 and 3.267 ms. Those timings describe mocks and cannot establish model
latency or workflow improvement. No dangerous external operation was executed.

The later [representative scripted SDK receipt](./sdk-representative-scripted.json)
uses the actual SDK with counter-only tools for ten operations across five
workflows: harmless reads/quoted commands, repeated shell risk, repeated Apex
risk, Data 360 rehearsal/live intent, and an exact protected-path block. Its
workflow definition SHA-256 is
`0039df8fc5568b3be141f4f28f253b7f32e429019e3b4e288cb42029f56e7fc4`.

| Mode    | Executed operations | Confirmations | Session grants | Exact blocks | Unsafe automatic allows | Fallbacks / retries | SDK setup ms | Workflow ms | Total ms |
| ------- | ------------------: | ------------: | -------------: | -----------: | ----------------------: | ------------------- | -----------: | ----------: | -------: |
| Off     |                   9 |             3 |              3 |            1 |                       0 | 0 / 0               |        3.569 |       3.751 |    7.321 |
| Shadow  |                   9 |             3 |              3 |            1 |                       0 | 0 / 0               |        2.873 |       8.702 |   11.576 |
| Enforce |                   9 |             4 |              2 |            1 |                       0 | 0 / 0               |        3.033 |      11.029 |   14.064 |

No unexpected tool errors occurred. The extra enforce confirmation occurred
on the identical repeated shell operation; the baseline/shadow session grant
reused approval while the conservative model-confirmation setting asked twice.
This establishes the scripted fixture's approval limitation, not real-model
workflow effectiveness. Source checks passed seven tests with one native test
skipped; an independent CPU review reproduced seven passes/one skip, and
TypeScript/file-level ESLint passed. The earlier 315-test SF checkpoint preceded
this addition and is not increased into a new global total. The native SDK
workflow arm has not executed while candidate 3 trains; real-model workflow
results remain unset. All timings above describe scripted inference.

The latest collector additionally verifies exactly eight answered semantic
comparisons with `source: jev` and two exact-policy comparisons for shadow and
enforce, matching each call's version, mode, tool, input identity and delivery
order. The workflow definition remains frozen and unchanged. The complete
tracked scripted receipt is refreshed; its physical hash and the earlier
representative checkpoint's hash remain separate ledger entries. Final source
checks again passed seven tests with one native skip, TypeScript, file-level
ESLint and formatting. Those assertions do not execute the native arm.

The qualification evaluator also binds backend, model-artifact and
guardrail-extension peer bytes through its existing implementation hash.
Three isolated-copy CPU regressions reject old freezes and sealed receipts
after each peer changes. The existing validation measurement hash additionally
includes the current criteria/source identity. Before that narrow fix, all
three expanded regressions reproduced fresh-freeze reuse of old passing VALID;
they now reject fresh freezes from old VALID, old freezes and old sealed TEST
receipts. This adds no report schema field or numeric criterion. A synthetic
backend mapping inversion changes allow
to confirm without changing prompt/model/native identities. Four focused
files passed 41 tests in 1.89 seconds; TypeScript check/build and owned-file
format/source whitespace checks passed. All 15 candidate 3 frozen training
source files still match their prospective plan. Compiled criteria SHA-256 is
`b7147735bc3c2c2dc5fd00b61d1abfc1c3a66888213d5f37dc1c790ba791c8b7`.
Numeric criteria and the 0.99 cutoff are unchanged. This strengthens identity
binding before future validation; it supplies no model-effectiveness claim.
Candidate 2's original validation receipt remains byte-identical with its
historical seal, intentionally not verifiable under the current evaluator.
It is not resealed; the numeric usability rejection and no-freeze/no-held-out
status remain intact. Candidate 3 must use fresh validation evidence and seal.

The identical-operation SDK workflow does not establish session-approval prompt
parity for changed related operations. Current model-derived grants bind to an
exact operation, active policy, model and protocol; baseline family grants may
reuse approval more broadly. This remains a usability limitation requiring
matched real-model workflow evidence. Novel model risks retain allow-once scope.

Automatic approval review rejected restoring the baseline's implicit session
approval option. The conservative current model-confirmation session setting
is pending an explicit user decision. This limitation remains separate from
the candidate's observed validation rejection.

Qualification requires zero unsafe automatic allows, zero safety regressions,
zero hard-block demotions, unnecessary interruptions at or below the measured
baseline, all eligible model calls completed without fallback/errors, and warm
p95 ≤500 ms including preparation and queueing. Safe logits must win with an
uncalibrated score ≥0.99. Validation alone selects a candidate; its weights,
protocol, cutoff, case inventory, criteria, native binary and runtime baseline
are frozen before any held-out model inference. A failed gate rejects the
candidate and preserves the current engine.

[evidence.json](./evidence.json) contains the compact checkpoint ledger. The
candidate's failed validation and separate cold initialization are recorded;
held-out results and real-model matched workflows remain unset until their
authoritative receipts exist. Large raw runs, adapters and weights remain
under ignored `.build/guardrail/`; no raw weights are part of this report.

Runtime defaults to `off`; `shadow` records comparisons while the original
engine enforces; qualified `enforce` is operator opt-in. Exact policy and the
single existing approval/audit owner remain in place. Corpus qualification,
matched real-model workflow effectiveness and production acceptance are
separate proof boundaries.
