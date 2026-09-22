# Implementation evidence

## Current guardrail replacement evidence

The current goal is equal-or-better semantic risk detection with no increase in
unnecessary interruptions. The Jev and sf-pi changes are isolated on
`barretts/jev-guardrail-risk` in
`/private/tmp/simple-jev-ts-guardrail-risk-20260921` (base `95c0b50`) and
`/private/tmp/sf-pi-guardrail-risk-20260921` (base `4f901db9`). The existing
sf-guardrail hook owns enforcement, human approvals, grants, revocations and
audit records. Jev supplies a versioned risk judgment; exact custom policy and
hard blocks remain authoritative. Default mode is `off`; rule fallback is
retained even when an operator enables the provider.

The dedicated machine-authored operation-policy corpus has 612 cases / 204
groups with 285 training, 165 validation and 162 held-out test cases; semantic
eligibility is 252 / 144 / 141. Human label review remains pending. Current
corpus SHA-256 is
`f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2`.
An executable comparison calls the actual old safety kernel and independently
resolves the complete raw request from generic mocked host observations. It
does not execute the requested tools. The fixed-label baseline has 30 unsafe
automatic allows and 17 unnecessary interruptions; all exact-policy floor
outcomes matched their labels. That establishes a reproducible local baseline,
not candidate effectiveness or population safety.

Candidate 1 was stopped at optimizer update 42/256 when source review found two
incomplete Data 360 rehearsal parameter sets. Its abandonment receipt records
zero held-out model calls. Candidate 2 starts afresh from pinned Google Gemma 3
1B with corrected complete inputs. Its 256 fixed optimizer updates completed;
the final train/validation and adapter-reload checks completed. Training loss
decreased from 4.70919 to 0.62621, the adapter changed, and reload maximum
probability delta was zero. Native prompt/token/label preparation parity checked
396 train/validation rows and 792 labels. A separate F16 export is recorded;
none of these checks establishes the native bridge's risk effectiveness.
The prepared RFDT input has exactly 252 training and 144 validation
branches; its test file has zero bytes. Neither optimizer completion nor MLX
validation is a native SF risk-check qualification result.

Candidate 2's actual native SF bridge validation subsequently completed 165
cases / 55 groups with all 144 eligible calls answered and zero errors or
fallbacks. Warm p95 was 208.353333 ms, including preparation/queueing; cold
initialization was 2,548.651041 ms. Unsafe allows were zero versus baseline 14,
with zero safety regressions and zero exact hard-block demotions. Unnecessary
interruptions were 75 versus baseline three, so the candidate is **rejected by
the usability gate**. It is neither qualified nor established as equally
effective. No prospective freeze or held-out model calls were made. The full
[native validation receipt](./reports/guardrail-risk-2026-09-21/sf-bridge-validation.json)
is retained with its measurement, model, protocol, corpus, runtime and native
binary identities.

The separate 18-case TRAIN-only diagnosis completed its prospectively fixed
256 updates with zero validation/test branches. Argmax classification was
18/18; all nine safe cases passed the 0.99 automatic-allow cutoff and none of
the nine risky cases automatically allowed. All 18 correct-class margins
exceeded ln(99). Mean cross-entropy decreased from 4.04255549 to 0.0000245306;
the minimum safe allow-minus-confirm margin was 8.8125 and the maximum risky
margin was -9.9375. Adapter reload probability delta was zero and the original
base remained unchanged. The [complete TRAIN diagnostic receipt](./reports/guardrail-risk-2026-09-21/train-overfit-diagnostic.json)
is bound to frozen plan SHA-256
`c2328cc3aac616865903db854edb9729f4c8c6c3d961744b1d66757e520fd71a`.
The source report SHA-256 is
`f3a804333d4fbf3638da590e16cc92a9866eb90be60014235d0452421935b711`;
the evidence ledger separately records the compact tracked copy's hash.
This proves memorization and pipeline behavior on those training cases only.
No validation/test evaluation, export, promotion or workflow claim follows.
Candidate 3's preparation verified 252 TRAIN / 144 validation / zero test
branches. Its original-base training started at 00:08:08 UTC on 2026-09-22,
with unchanged inputs and profile and 1,536 fixed updates. The prospective
training plan SHA-256 is
`60c50c1c21930ad233f489fce5d7deb98e8caaff2e2302d046c6651c72f736dc`.
The preparation worker was disposed before MLX training. The owned helper
completed with exit zero and awaited its children. All 1,536 updates completed;
mean TRAIN cross-entropy decreased from 4.70918719 to 0.0000075310. The full
post-fit adapter evaluation classified 252/252 TRAIN cases correctly, allowed
all 129 safe cases at the fixed 0.99 cutoff, and allowed none of the 123 risky
cases. All correct-class margins exceeded ln(99); minimum safe margin was
8.31249964 and maximum risky margin was -8.18749958. Reload delta was zero,
all 15 frozen source pins matched, and the original base was preserved. The
[complete TRAIN receipt](./reports/guardrail-risk-2026-09-21/candidate-3-full-train.json)
retains all 252 score vectors and the source-report identities. These are
TRAIN fit and checkpoint results, separate from native generalization.

A separately authorized F16 export uses the separate candidate registry with
model ID `jev/gemma-3-1b-guardrail-candidate-3`, SHA-256
`c87022dfe3090765ffbd25d792fb9263bed914f1c37cc090e1130c2987b537be`,
2,006,573,408 bytes. The [actual SF bridge validation receipt](./reports/guardrail-risk-2026-09-21/candidate-3-sf-bridge-validation.json)
contains all 165 validation records / 55 groups. Every eligible call answered
(144/144), with zero execution errors/fallbacks and zero hard-block demotions.
Warm p95 was 213.735667 ms; cold initialization was 2,647.130459 ms.
Six unsafe automatic allows, five safety regressions, and 19 unnecessary
interruptions versus baseline three failed three fixed gates. Candidate 3 is
**rejected and unqualified**; successful TRAIN fit does not establish sufficient
generalization. Independent CPU review verified the original current seal,
metrics/gates, model/native identities and all 33 runtime source pins. The
[freeze refusal receipt](./reports/guardrail-risk-2026-09-21/candidate-3-freeze-refusal.json)
records expected CLI exit 1, the failed-validation prohibition on held-out
testing, and no freeze output. No held-out model call or promotion occurred.
Candidate 4 TRAIN-only counterfactual diversity preparation remains pending.

The CPU-only initial-256 parity receipt at
`.build/guardrail/candidate-3/initial-256-parity-receipt.json` has SHA-256
`40065c9ce5dc8a2163a3d88073467a1870b40bb6a00e28a9832aaa11371f2e67`.
Independent replay compared all 256 overlapping step IDs and recorded TRAIN
batch losses against candidate 2, matching 256/256 exactly with maximum
absolute difference zero. All seven bound plan/input-file hashes matched;
authored and prepared TRAIN inputs are unchanged. This is saved-scalar
reproducibility evidence using no extra model calls or held-out data. The later
completed training and failed native validation are separate observations;
the matching initial losses do not establish qualification.

The initial interface draft passed 24 focused Jev tests and 46 focused sf-pi
tests. The recorded full Jev source checkpoint before the later evaluator seal
fixes passed 1,011 tests across 46 files in 10.44 seconds,
with isolated Pi state and narrowly escalated local fixture listeners. The
TypeScript/package checks, build, 38 focused guardrail tests across four files
and formatting also passed. SF guardrail/runtime checks passed 315 tests (one
further test skipped), and six actual Pi SDK tests passed. Those establish the
covered contracts and lifecycle behavior. SF test files were exercised across
appropriate isolated partitions:
the broad 593-file run had 4,214 passes, one failure and 40 skips; its unrelated
AgentScript dynamic-import timeout passed in a four-test isolated replay. Six
state-sensitive files passed all 70 tests with an isolated agent directory, and
two localhost files passed eight tests with narrowly escalated local fixtures.
Final SF lint and documentation/validation stages before the full-suite stage
passed. A uniform `npm test`/`validate:ci` command did not pass under the sandbox;
partition coverage is not a claim of that uniform command's success.
Exact run counts and scope are retained in
[the guardrail evidence report](./reports/guardrail-risk-2026-09-21/README.md).

The repeated package dry run passed with 171 files, 6,194,598 unpacked bytes and
1,280,112 tarball bytes after the workflow patch and setup guide update, including
required guardrail sources, corpus, scripts and patch, with no weights. It used
a worktree-local npm cache. These size observations precede recording the sizes
and are not a sealed final archive identity. The SF patch
contains four email patches: initial integration `beaa11c0`, workflow proof
`24546444`, ADR0052 clarification `eab0eac6`, and semantic-call completeness
checks `388990554479450d223dbc4448eb80179246ef2f`. Its SHA-256 is
`a523d5de1648b675adfeea650480a7e0c82c4ac6929c78b9788ad9a3f2e493e1`,
with 165,300 bytes. Splitting and applying the four patches sequentially against
the pinned `4f901db9` baseline in a separate index reproduced final tree
`944cee65cd156f11afa96dde179388f4d06b70e3`. The real checkout/index remained
unchanged; no push or active Pi host change is part of that proof. Runtime
baseline identity remains `0f31a95043fc761347a9ccc51dc673b6aaea77d9ca61bd129f789eaa51fa1f45`.

The actual Pi SDK matched workflow uses scripted inference and counter-only
tools. Both `off` and `shadow` accepted two requests with one confirmation, one
session grant, no retries and no errors. SDK setup and workflow elapsed times
are separate measurements. The real-hook stub workflow also records equal
accepted outcomes and confirmations for `off`, `shadow` and `enforce`. These
prove controlled execution/approval behavior; they do not measure local Jev
candidate accuracy, model cold initialization, warm model latency, complete
developer-task benefit or dangerous external execution.

A later [representative scripted SDK receipt](./reports/guardrail-risk-2026-09-21/sdk-representative-scripted.json)
covers ten operations in five frozen workflows. Off and shadow each executed
nine operations with three confirmations and three session grants; enforce
executed nine with four confirmations and two grants. Every mode preserved
one explicit protected-path block and recorded zero unsafe automatic allows,
fallbacks, retries and unexpected tool errors. The extra enforce prompt was a
repeat of the identical shell operation, exposing the conservative session
setting's approval limitation. Scripted timings and predictions remain mock
evidence, separate from the subsequent actual native SDK fixture.
The workflow definition SHA-256 is
`0039df8fc5568b3be141f4f28f253b7f32e429019e3b4e288cb42029f56e7fc4`.
The new SDK test file passed seven tests with one native test skipped; an
independent CPU review reproduced that result, and TypeScript/file-level lint
passed. The earlier 315-test SF checkpoint predates this test file; no new
global pass count or uniform-suite success is inferred.

The final scripted receipt verifies exactly eight semantic comparisons with
`source: jev` and two exact-policy comparisons for both shadow and enforce.
Per-call version, mode, tool, input identity and delivery order match the frozen
workflow; no fallback can substitute for an answered semantic call in that
collector proof. The definition SHA-256 is unchanged. The latest source test
still passed seven tests with one native skip, plus TypeScript, file-level lint
and formatting. This remains scripted SDK evidence.

The [actual candidate 3 native SDK receipt](./reports/guardrail-risk-2026-09-21/candidate-3-sdk-representative-native.json)
uses genuine local Jev inference with the actual Pi `AgentSession.prompt` and
`ExtensionRunner`, scripted choices, authored org facts and counter-only tools.
The selected native test passed, with seven other tests skipped by selection.
Off and shadow each executed nine operations, preserved one expected protected
block, required three confirmations and three grants, and recorded no unsafe
automatic allows, fallback, retries or unexpected errors. Shadow answered all
eight semantic calls and recorded both exact-policy comparisons; off expected
zero model calls and never initialized weights. Off setup/workflow/total were
13.313625 / 9.956083 / 23.318750 ms. Shadow setup/model cold/workflow/total were
3.350458 / 2,646.483750 / 1,615.331084 / 4,265.249375 ms. The rule engine
enforced both modes. This proves shadow isolation and measures local native
overhead on this authored fixture; an unqualified model did not execute
enforce, and no workflow improvement or production acceptance is established.

The evaluator's implementation byte-binding additionally covers the backend,
model-artifact and guardrail-extension peers, using the corresponding `.ts`
or `.js` source form. Three isolated-copy CPU regressions reject an old freeze
and sealed receipt after peer bytes change. The existing validation measurement
hash now includes the current criteria/source identity, closing fresh-freeze
reuse of old passing VALID. The expanded regressions reproduced that bypass
in all three copied-peer cases before the fix and now reject fresh freezes
from old VALID, old freezes and old sealed TEST receipts. No report schema
field or numeric criterion was added. A synthetic copied-backend mapping
inversion changes allow to confirm while retaining prompt/model/native
identities, demonstrating why those client bytes must be bound. Four focused
files passed 41 tests in 1.89 seconds after the fixes, separately from the
earlier full-suite checkpoint; TypeScript check/build and owned-file
formatting/source whitespace checks passed. All 15 candidate 3 frozen training
source files remain unchanged. Compiled criteria SHA-256 is
`b7147735bc3c2c2dc5fd00b61d1abfc1c3a66888213d5f37dc1c790ba791c8b7`;
the numeric criteria and 0.99 cutoff are unchanged. This CPU identity evidence
does not establish model quality, workflow benefit or held-out qualification.
Candidate 2's preserved validation receipt retains its original historical
seal, intentionally not current-verifiable. No resealing occurred; its
numeric usability rejection and no-freeze/no-held-out status are unchanged.
Candidate 3's fresh validation receipt uses the current seal and was
independently verified; its failed gates prohibit freezing and held-out testing.

The SDK workflow repeats an identical operation. It does not establish prompt
parity when related operation payloads change: current model-derived session
grants are exact and bound to operation/policy/model/protocol, while baseline
operation-family grants may permit broader reuse. That usability limitation
must be measured in matched workflows; tool-supplied approval claims remain
insufficient and novel model risks do not receive a broad session grant.

Automatic approval review rejected restoration of the baseline's implicit
session-approval option. The current conservative model-confirmation session
setting is pending an explicit user decision; tests cannot establish usability
parity while that limitation remains.

Qualification requires a passing real SF bridge validation result followed by
a prospective freeze and a complete held-out bridge test. Every frozen case,
gold/baseline outcome, model/protocol/native/runtime identity and active policy
is bound. Scores remain uncalibrated. Gates require zero unsafe allows, no
safety regression, no exact-block demotion, unnecessary interruptions no higher
than baseline, all eligible calls completed without fallback/error, and warm
p95 ≤500 ms including request preparation and queueing. Cold initialization is
reported separately. Qualification, improvement and production acceptance
remain separate claims; failed qualification keeps the current engine active.

## Historical implementation and evaluation evidence

The following delivery and evaluation records describe earlier experiments;
they remain unchanged and do not qualify the guardrail candidate.

The TypeScript package is at `/Users/bsonntag/code/simple-jev-ts`, with earlier evaluation work on `feat/developer-improvement` in the private repository `barretts/simple-jev-ts`. The initial delivered commit is `0fef15dab99ec01d8ec091359c773b3e2db942be`; the expanded source checkpoint is `7a8f823e0375419030b08d81de81efdc580d77e6`, the hardened source checkpoint is `4d30c58d43912c76fe0e1dffd236517f730d4909`, the download-recovery source checkpoint is `47d7c2efc02374912aa9444efaf939550690348e`, the Metal startup/fixture checkpoint is `ba82de592fb80b2e9014c685e708b748724740d6`, and the typed-teacher/cache checkpoint is `e6b64ac24760a726f3d8a848c8e7a6a080e0cd09`. All were committed and pushed privately. Subsequent real-model evidence is recorded below. Native builds, weights, private run data, and raw proof files are excluded from Git.

The original Simple Jev checkout remains unchanged. The original sf-pi checkout remains unchanged, including its existing untracked `.logs/`. Manager work is isolated in `/Users/bsonntag/code/sf-pi-jev-manager`, branch `barretts/jev-external-manager`, against baseline `4f901db9c3f5076ea0305dea33ad6e8856e467da`. Global pi preferences are preserved; integration exercises use isolated agent/workspace directories. No public sf-pi push is part of this delivery.

## Completed exact-excerpt answer-effectiveness evaluation

The [final evidence](./research/context-effectiveness-root-1/RESULTS.md) records all 192 scheduled Pi/sf-pi workflows, zero unrun workflow slots, the fixed Grok 4.6 task model, all 23 controlled factories and genuine builtin reads with registered original retrieval. Native short controls and exact scoped long variants preserve the original source-blind V3 gold. A reproducible post-freeze CPU checker verified 24 original cases/56 fields and all 24 long scopes; its timing is declared rather than presented as a prospective blind check.

Full context accepted 84/96 workflows (87.50%); excerpts accepted 86/96 (89.58%). Short controls accepted 41/48 per arm and did not compress. Long cases applied compression in all 48 excerpt workflows, accepting 45/48 versus 43/48 raw. Paired whole-workflow results were 83 both accepted, three excerpt-favored, one raw-favored and nine neither accepted. Of the three excerpt-favored pairs, two were completed Unicode answers whose raw counterparts failed JSON parsing; one was a correct excerpt answer paired with a raw execution error. The regression was `quality-v3-22-long__r1`, a multiline exact body-count/position task: the excerpt answer parsed as JSON but matched only one of two fields, despite a recovery turn. The second repetition passed. Which field was wrong and an omission-only cause are not established because final model text was deliberately not persisted.

All 399 physical task requests have complete core server usage: raw 1,593,640 prompt/67,235 output/1,660,875 total tokens; excerpts 625,273 prompt/86,569 output/711,842 total. Aggregate prompt reduction was 60.76% and total-token reduction 57.14%, including failed physical calls and recovery. Output increased 28.76%. Summed physical task-request elapsed, including shared pacing and failures but excluding judges, increased 18.67%; this is not production latency. The strict successful-execution gate remains false and the CLI exited 1 because three raw and two excerpt workflows failed. The independent audit separates all-slots-observed from all-successful execution; no failure was deleted to calculate a passing result.

All 187 completed workflows verified exact canonical originals, provider-wire delivery and affirmative cleanup. Original proof was affirmative for 190/192 total records; the two failed short last-write workflows lack affirmative original proof. All 192 session cleanups and final runtime credential cleanup completed. No HTTP 429 responses occurred. The supplementary Grok judge attempted 94 of 96 scheduled judgments: 24 valid/supporting, 70 failed, two unrun. No disagreement occurred within the valid subset; unknown judge usage stays unknown and does not establish support for failed cases.

The independent audit verifies 26 executed source/runtime pins and 24 controlled SF pins, individual workflow records, full-denominator quality, family/stratum summaries, physical request multiplicity and judge disagreement accounting. Source archive and protocol bind the dirty preparation snapshot rather than claiming inference used a later documentation HEAD. Eight Python audit/gold/report tests and 21 focused Node protocol tests passed. No model training, scoring or frozen-case changes were made in response to inference results. Production qualification, natural developer-task effectiveness, population noninferiority and billing savings remain unproven.

## Inputs and identities

| Input                            | Identity                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Simple Jev behavior baseline     | `0dd5396ffce671ab7c4bfc031506d8e558cf8d23`                                                          |
| sf-pi baseline                   | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                          |
| pi SDK / TUI                     | `0.85.1`                                                                                            |
| llama.cpp source                 | `f072b103714dfa1eee531f80b24512faf38e3dd2`                                                          |
| Initial classifier               | `google/gemma-3-1b-it`                                                                              |
| GGUF publisher / revision        | `ggml-org/gemma-3-1b-it-GGUF` / `f9c28bcd85737ffc5aef028638d3341d49869c27`                          |
| Classifier file                  | `gemma-3-1b-it-f16.gguf`, 2,006,573,568 bytes                                                       |
| Classifier SHA-256               | `05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5`                                  |
| Reviewed 4B classifier candidate | `google/gemma-3-4b-it`, `ggml-org/gemma-3-4b-it-GGUF@d0976223747697cb51e056d85c532013931fe52e`      |
| 4B file / size                   | `gemma-3-4b-it-f16.gguf`, 7,767,474,336 bytes                                                       |
| 4B SHA-256                       | `29f4b518b636635613894282bda2a01bad964c8d474c4147343057b7ac442d50`                                  |
| Agent/teacher                    | `google/gemma-4-31B-it-qat-q4_0`                                                                    |
| Official GGUF revision           | `59dde24573e7e61570dba08b18a2e1fe246955ed`                                                          |
| Agent/teacher file               | `gemma-4-31B_q4_0-it.gguf`, 17,651,001,568 bytes                                                    |
| Agent/teacher SHA-256            | `179cfb99212709597eae5929112cfca677e1bbf566178b479ae1da0c4772874b`                                  |
| Agent chat template revision     | `842da3794eaa0b77d5f08bae87a17459d91ff475`                                                          |
| Agent chat template SHA-256      | `ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4`                                  |
| RFDT HF base revision            | `google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752`                                     |
| RFDT Python / MLX / Transformers | `3.13` / `0.32.2` / `5.11.0`                                                                        |
| RFDT MLX-LM source               | `9d1e356e7cc6549e7d1697adabe2ea01ff8e062c`                                                          |
| RFDT converter dependency        | PyTorch `2.11.0`                                                                                    |
| Frozen quality corpus            | 300 records, 150 groups, SHA-256 `cd3de2d07db024aeb0f8d22be394ffa9024307680efbe2967569c325bc7af3c9` |

All executed classifier/training fixtures use Gemma. No Qwen or Chinese-lineage model is used. CPU exactly expands verified F16 weights to a temporary F32 GGUF with F32 KV caches; Metal uses the source artifact and F32 KV caches. This remains an independent rewrite with source inspection permitted, not a source-separated clean-room process.

## Runtime evidence

The fresh real Metal exercise at `.build/runtime-proof.json` completed in 5.57 seconds and proved:

- Concurrent warmup callers share one initialized generation.
- Loaded status identifies actual `MTL0`, Gemma3 architecture, the approved artifact checksum/revision, and the full native source commit.
- Choice, score, and Noul return real results with zero generated output tokens.
- Natural single-user chat works under v1 and v2. The native renderer merges the appended question into the final user turn without altering logical v1 fixture messages.
- An in-flight large-context abort returns `AbortError: Cancelled`; the next classification succeeds.
- Actual native SIGKILL is followed by successful explicit generation-2 recovery. The failed request is not replayed.
- Disposal awaits child exit and removes the owned temporary directory.

The sample duplicate-charge request produced a billing route, support score approximately 1.9995/2, and v2 refund score approximately 0.98995. The corresponding unchanged v1 refund score remained approximately 0.01. This is a regression diagnostic, not a claim that v2 meets the authored quality gates. Each v2 candidate is bound by its report's logical prompt hashes.

Twenty-five focused runtime/backend tests passed, including shared initialization, caller cancellation, deadlines, malformed replies, explicit recovery, TERM/KILL escalation, and the disposal/directory-creation race. The native protocol checks exercised malformed envelopes, size/depth/numeric limits, and late cancellation bookkeeping without inference. The one-active-plus-16-pending capacity, pre-expansion admission, and bounded cleanup are implemented and tested.

## Quality evidence

The fixed authored corpus was frozen before inference. State/chat pairs share their context group and split. Choice pairs reverse candidate order; Noul contains 40 true, 40 false, and 20 unknown records. Known refund and dog regressions are fixed validation records. The held-out test split was untouched during candidate selection and was evaluated once after the final student was frozen.

After fixing native chat rendering, paired validation completed all 60 records with zero execution errors:

| Validation candidate | Choice accuracy | Clear Noul accuracy | Noul Brier | Normalized score MAE | Regressions |
| -------------------- | --------------: | ------------------: | ---------: | -------------------: | ----------: |
| v1, chat fix         |            0.50 |                0.50 |    0.49010 |              0.25437 |         2/6 |
| v2 candidate 2       |            0.80 |                0.50 |    0.46013 |              0.20082 |         4/6 |
| v2 candidate 3       |            0.50 |                0.50 |    0.20341 |              0.23031 |         4/6 |
| v2 candidate 4       |            0.65 |              0.6875 |    0.23902 |              0.25325 |         4/6 |
| v2 candidate 5       |            0.80 |                0.75 |    0.21736 |              0.41724 |         4/6 |
| v2 candidate 6       |            0.65 |                0.75 |    0.21736 |              0.14929 |         4/6 |
| v2 C7, Gemma 3 4B    |            0.85 |                1.00 |    0.00180 |              0.07971 |         6/6 |
| v2 C8, Gemma 3 4B    |            0.80 |                1.00 |    0.00411 |              0.07971 |         6/6 |
| v2 C9, Gemma 3 4B    |            0.80 |               0.875 |    0.12233 |              0.07971 |         4/6 |

These candidates **fail the quality gates**. Gates require choice ≥0.90, clear Noul ≥0.95, Brier ≤0.10, normalized score MAE ≤0.10, all known regressions, and zero errors. Candidate 2's prompt manifest SHA-256 is `e5b1a1d005e0d5845c260d173c032e9e88f5861b1c52f29f635be3adfcdd49ad`; reports retain the exact artifact/template identity and per-record prompt hashes. Selected-record dataset hashes differ from the whole-file frozen corpus hash by design.

The initial candidate-5 invocation omitted `JEV_MODEL_FILE` and failed configuration on all records. Its report was replaced by the correctly configured real run above. C7's prompt was frozen for stronger-artifact validation, with prompt-region SHA-256 `5fb3187d5a77359c8b52996d30c3d7c9911b6d6234b8351599aefc17a1fc40fa`. Labels and held-out records are not changed to improve metrics.

The independently hashed 4B F16 artifact completed C7 validation with 60 records and zero execution errors. Only the formal choice gate failed: 17/20 correct versus the required 18/20. Clear Noul was 16/16 correct, Brier `0.0018000026`, score normalized MAE `0.0797098268`, and all six marked regressions passed. Its four unknown Noul cases had uncertainty MAE `0.4899893714`, a substantial answer limitation even though that metric is outside the agreed formal gates. The report and execution attribution are `.build/quality-v2-validation-gemma4b-candidate7.json` and its `-attribution.json` companion. This candidate was not selected for held-out evaluation or default promotion.

C8's canonical choice objects and JSON answer boundary improved state choice accuracy to 10/10, while chat scored 6/10. Overall choice fell to 0.80, and unknown Noul remained poor at uncertainty MAE `0.4899736232`. C8 was not promoted. C9 standardizes the context presentation for choice/Noul state and chat without changing their roles or caller input, and uses a three-way Noul truth table. Ordered score plans remain exactly unchanged. Controlled validation diagnostics precede the full fixed validation run; no held-out inference is used to select the prompt.

C9's 14-request controlled diagnostic produced bit-exact selected logits for all seven same-options state/chat pairs (maximum difference zero). Reversing the options caused all three tested choice groups to change from correct to wrong, isolating an option-label binding failure after context normalization. The complete fixed C9 validation still failed as shown above, with unknown MAE `0.4033487549` and zero execution errors. C9 is retained as a frozen student-training compiler because it provides consistent context and answer formatting; this is an explicit training choice, not a claim that its base-model quality improved. The report binds source SHA-256 `6c019fadb85344f0e1c7b42a1d5cb98bab9fb2d0c885fa137c939b558d2e2944` and prompt manifest `f95f1e1da29bcb20073e0535008ae60d7adae86630bf896e24b43a2ebb2b48e5`. The tracked v1 checker remains exact at 72 Plans and 432 answer/usage comparisons; additional independent checks preserve all tested v2 score plans.

The tracked compatibility checker passed 72 exact whole-Plan comparisons and 432 exact answer/usage comparisons between current v1 code and initial TypeScript commit `0fef15dab99ec01d8ec091359c773b3e2db942be`, with zero differences. It reports intentional metadata-envelope changes separately. This comparison complements the captured upstream Python fixtures; it does not claim arbitrary Python/JavaScript coercion equivalence.

## Agent and teacher artifacts

The first large Node range transfer stalled after receiving 16,569,171,182 bytes (93.87%). Its incomplete result was not treated as a reviewed model. Recovery used an isolated owned Hugging Face Hub/Xet cache, the exact approved public Google repository/revision, `token=False`, and disabled implicit account-token use. That actual transfer completed at 05:41:48 UTC; the complete 17,651,001,568-byte model passed full SHA-256 `179cfb99212709597eae5929112cfca677e1bbf566178b479ae1da0c4772874b`, with 264 retained range hashes. The official 18,683-byte template then passed SHA-256 `ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4`. The model was independently rehashed by the public agent-role verifier. Binding proof is `.build/agent-model-template-binding.json`, SHA-256 `8f65c0be4e3ff499414f1164c99ecfcdbb1c679c018ae285a5c25a6780aac376`.

Recovery PID 73939 exited without a restart or forced kill. The unknown older partial was preserved byte-for-byte at its existing inode/size/allocation/modification identity, recorded in `.build/agent-recovery-preservation.json`. Verified weights and cache remain private local artifacts; no weights or account credential entered the source package.

The exposed range-download recovery defect is fixed at source checkpoint `47d7c2e`: completed ranges and their hashes survive interruption, a later owner rechecks them before requesting missing ranges, and the full pinned size/hash remains mandatory before promotion. Unknown, malformed, linked, or live-owned state is preserved; stale ownership and cancellation are handled explicitly. Eight focused resumption/cancellation regressions and all 48 model tests passed; the existing independent review converged without a blocker. The complete source suite then passed **239 tests across 21 files**, TypeScript check/build, formatting, and scoped whitespace checks. The frozen C9 source and compiled-core hashes stayed unchanged.

The first actual agent-server launch stopped because it could not confirm Metal/offload evidence. Pinned llama.cpp maps the GPU startup INFO messages to verbosity level 4, while its default is 3. A second launch then positively logged `MTL0 (Apple M3 Max)` and 61/61 offloaded layers but was rejected because the wrapper expected an older GPU-name field. The owned server now requests level 4 explicitly and accepts the pinned source's selected-device line from `llama_prepare_model_devices`, while retaining the positive offloaded-layer and `MTL` checks. Inventory alone, absent evidence, zero-layer offload, and other devices still fail. All 13 focused startup tests passed. Both failed native logs are retained, and their process, state file, and loopback port were independently confirmed stopped before retry.

The third actual owned startup passed: PID 67808, `127.0.0.1:8081`, `MTL0 (Apple M3 Max)`, and 61/61 offloaded layers, with model/template/binary/source identities recorded. The frozen pi exercise loaded all 24 factories and 33 tools and used the unmodified SDK stream, the exact local Gemma 4 alias, automatic tool choice, and an exact-loopback transport guard. Its first all-sf-pi request contained 20,641 prompt tokens. The initial three-minute classification case timed out after 184,168 ms during prefill, before any tool execution. The arithmetic control passed after 179,139 ms, returning exactly `42` with zero tools. The initial overall proof correctly remains false; its proof, invocation, logs, fetch events, and native snapshot are preserved separately. A ten-minute per-case rerun changes only the explicit verification deadline, retaining the frozen script, prompt, provider behavior, and automatic selection.

The separate ten-minute trial **passed both cases** at `.build/private-gemma4-final/live-proof-600.json`. The real Gemma 4 response selected exactly one `jev_classify` call. Pi validated and dispatched it to the reviewed official Gemma 3 1B classifier on Metal, obtained all three answer types, replayed the successful result to the provider, and received the following final assistant response. The classifier accounted for **683 input tokens and zero generated output tokens**, with the exact reviewed artifact hash and full native commit. The complete classification case took 154,268 ms; the arithmetic control took 31,437 ms and returned exactly `42` with no tools. No lifecycle errors, remote fetches, forced tool selection, stream substitutions, or provider/session automatic retries occurred. The first classification request body SHA-256 `658fd9e50dd678362a4855af03836936fba77a3af23889e8d055890cff6ac3fe` exactly matches the earlier timed-out attempt.

This establishes autonomous selection and tool-result use for these two controlled prompts. The successful rerun used the native warm prompt cache and is not cold-latency evidence or a broad autonomous-routing accuracy evaluation. The final measured customer response reported billing probability approximately 0.9977, fully supported duplicate-charge evidence, and refund truth score approximately 0.8775. The official base classifier's failed quality-suite results still apply. Actual stderr includes the sf-pi Manager event-emitter listener-count warning during startup; it was retained rather than suppressed, and the two completed cases reported no extension lifecycle errors.

The initial real teacher trial failed honestly after **three HTTP 200 responses in 82.725 seconds**. Each returned the correct `refund_duplicate` choice answer with additional `score` and `noul` fields, which the strict choice-target validator rejected. Inspection also established that invalid estimates had been assigned before validation and written to the isolated cache after all retries. The failed proof, all three responses, and invalid cache are preserved under `.build/private-gemma4-final/teacher`; they are not successful teacher evidence. The corrective teacher path uses missing-question type-specific structured output and validates the entire estimate set before assignment or cache writes, validates cached estimates before use, versions the request format in cache identity, and rejects redirects from the validated loopback endpoint. A fresh actual teacher trial is separate from that retained failure.

The repaired actual teacher trial **passed** at `.build/private-gemma4-final/teacher-repaired/proof.json`. One HTTP 200 response returned exactly `{"requested_action":{"answer":"refund_duplicate"}}`; its hard choice normalized to `[1,0]` with `teacher_estimate` provenance. Repeating the same original incomplete input caused one cache hit, zero POSTs, and a byte-identical labeled output. Fully supplied input caused zero POSTs and zero teacher estimates. All three supplied values and their provenance were preserved in each phase. The request contained a native JSON schema for only the missing question, with contract SHA-256 `eb27686c766006f326f73b338eb9e2a9a66393b97ee109c01e07749aeef56527`. The new cache key differs from the retained invalid old entry. Actual response usage was 292 prompt tokens and 168 completion tokens; this generative teacher is separate from the zero-output-token classifier. The supplied-label student run above did not use this teacher response.

The repaired trial used the same owned Google Gemma 4 artifact/template, Metal device, 61 offloaded layers, and pinned native binary. Source SHA-256 was `2070cf624e51e2d3044e820dd2ae1594715245b16b7dd52956af20dc66c97865`, and executed RFDT distribution SHA-256 was `22043a9e556481d818334854bb057a2368607bb1b0035fc4435abf098c3942f0`. The complete request, raw response, typed request format, output, cache, and process identity are recorded without response substitution. Ten focused teacher tests also passed, covering invalid-response/cache rejection, all target types and supported distributions, old-cache isolation, supplied-label semantics, and local redirect rejection with zero forwarded requests. The actual one-hot choice is a training estimate, not authentic soft token probabilities, calibrated confidence, or a broad teacher-quality evaluation.

The owned agent server was stopped after the actual pi and teacher exercises. `.build/private-gemma4-final/owned-server-cleanup-proof.json` independently records exact PID 67808 absent (`ESRCH`), `127.0.0.1:8081` closed (`ECONNREFUSED`), state file absent, public API status `stopped`, and zero remaining Jev classifier processes. Final native log SHA-256 is `c8b9e966dcf33bcbef5dc593b52e7cd51f31508cf3cb959a3a71cba6fd28d6be`. Verified local model caches remain; the temporary HF session credential and its owner metadata were already removed. No global account login changed.

## pi, Manager, and browser evidence

The initial deterministic pi exercise established `session.prompt()` → argument validation → tool dispatch → real Gemma inference → tool result → next assistant turn, with one execution in two assistant turns and all 23 sf-pi extensions loaded alongside Jev. Its stream function authored the tool call. It does not establish autonomous selection; the actual real-provider Gemma4 proof above establishes the separate autonomous lane for two controlled prompts.

The final Manager change is local commit `f927d52f57185bb5f2d62e8f0cb6997a6656752c`, with tested tree `a95fd8662f9d5d39e491601b662c1b181cb55dab` and exactly ten changed files. Its final typecheck, full lint/generated-catalog checks, 281 focused tests across 27 files, and bounded full suite passed: **4,301 tests passed, 39 skipped; 599 files passed, one skipped**, exit 0. The worktree is clean, with no stash or sf-pi remote push. The baseline-bound patch at `integrations/sf-pi-manager/0001-feat-manager-discover-independent-external-extensions.patch` has SHA-256 `3ef59cbcb4ffd7162d5d1e29203ea36da12bfda2986605eea7408362cfee9a97`; temporary-index application reproduced the tested committed tree exactly. Review fixes cover scope-specific factory caching, stale factory promises, action completion refresh, and reserved contribution IDs.

The expanded pi proof at `.build/pi-proof-final.json` loaded all 24 real factories and 33 startup tools from the updated isolated sf-pi worktree and Jev. It exercised public Manager detail/settings/deep-link/actions/enablement and then actual v2 Metal classifier dispatch, all three answers, 401 input tokens, and zero outputs. Two user/final pairs produced two routing and two three-rubric evaluation reports. Repeated settled/end events created no duplicates; no extra assistant/tool turn or active-tool change occurred. The load-only proof stayed cold. Both Apex advice prompts selected `code-analyzer`, exposing a routing accuracy limitation; hook execution is proven, correct routing is not.

The live browser proof at `.build/browser-proof-final/actual` passed in isolated headless Chrome. All ten screenshots were inspected. It exercised a real all-three classifier POST (403 input tokens, zero outputs), exact response rendering, literal script markup, malformed client JSON without another POST, structured HTTP 422, local docs, four actual saved advisory reports checked against their source records, read-only inspection, and scoped 404s. There were no page errors or external requests. Server closure and native exit were independently verified. This software browser proof used a separate temporary profile and changed no user tabs.

Separate cold browser passes at `.build/rfdt-inspector-proof-final` and `.build/rfdt-native-inspector-proof-final` displayed byte-identical snapshots of the real trained and exported run manifests. The native snapshot's referenced report hash and summary were independently checked, and its failed quality gates rendered as false. Inspector support now includes `native_validation` and `native_test` as well as MLX summaries. Numeric metrics, boolean gates, known artifact labels, and SHA-256 identities are exposed; paths, raw results, bindings, prompts, and training files are omitted. Production-shaped HTTP/privacy regressions passed. Each browser pass made only 15 GETs, with zero POSTs, external requests, page errors, model loads, or native generations; both screenshots per pass were inspected. Owned browser/server closure was verified independently.

The final cold browser pass at `.build/rfdt-final-test-inspector-proof-final` rendered a byte-identical snapshot of the actual C9 final manifest, SHA-256 `d16e755aaee319d6b6507f1b4ab5bff3f6c4a05d7298acaa856709766dcf6172`. It independently checked both native reports and the physical exported GGUF, showed native validation `passed: true` and native test `passed: false`, and displayed the failed score gate and MAE 0.1139341655. Both screenshots were inspected. All 15 requests were GETs; there were zero POSTs, classifier requests, external page requests, page errors, native processes, or model loads. Seven scope probes returned 404, summaries passed privacy checks, and owned server/browser closure was verified. The permanent registry remained absent.

The actual CLI benchmark at `.build/bench-proof-final.json` completed 43/43 requests across eight combinations of 256/1,024-character context, 1/3 branches, and 1/4 concurrent callers, with two iterations each. Cold first request was 1.5077 seconds; warm median was 0.08898 seconds (n=2). Overall p50/p95/p99 were 0.23173/0.59468/1.13045 seconds, including cold and queue time. Measured work was 13,527 computed prompt tokens and zero outputs, approximately 2,964 prompt tokens per backend second. Sixty-five resource samples observed native peak RSS 4,806,901,760 bytes, orchestrator peak RSS 156,696,576 bytes, and zero owned temporary disk on Metal. `.build/bench-validation-final.json` verified queue wait, exact identities/code hashes, native exit, and temporary-directory removal. These one-machine observations with two iterations do not establish stable tail latency; RSS is not device memory.

## RFDT evidence

The Python worker's CPU random tiny **Gemma** fixture proved selected-position gradients, adapter changes, loss reduction from `1.6776810884` to `0.6417329311`, adapter reload probability difference `0`, and float32 fused probability difference `7.4505805969e-8`. Pinned conversion dependencies are installed and the llama.cpp converter's help path works. This fixture does not establish training on the official Google checkpoint, native GGUF equivalence, quality gates, or student promotion.

The initial unauthenticated checkpoint check returned HTTP 401 `GatedRepo`. After the user's session authorization, the exact pinned Google checkpoint downloaded successfully: 2,039,043,660 blob bytes, eight complete blobs, and no incomplete blobs. The authenticated doctor reports `training_ready: true` and verified all 180 prepared rows and 980 answer-label boundaries against the native tokenizer, with v2 and no extra special tokens. Optimization uses that exact local snapshot offline. The temporary session credential and credential-owner metadata were removed after download; `.build/hf-session-cleanup-proof.json` records removal and cache preservation. No global Hugging Face login or Git credential changed, and no alternate checkpoint is substituted.

The actual native preparation proof at `.build/rfdt-native-prepare/prepare-proof.json` compiled 180 frozen training records into 60 choice, 60 score, and 60 Noul branches using the approved Gemma1B tokenizer and current v2 template. Prompt lengths were 170–328 tokens with distinct valid answer-token IDs. The source SHA-256 is `7935316728623500ca906dde371355ab9d0550deffa7797e9c3fddc43f792abd`; prepared SHA-256 is `1da456847a5d6f95a841250bc1711f093cd05be2f37493bc1de55d7da2c60c83`. Validation/test branches were zero, and this stage performed preparation rather than optimization or held-out inference.

The real pinned Google 1B run completed eight optimizer updates, batch size one with gradient accumulation eight, learning rate `0.0001`, seed 42, and rank-16 Q/V LoRA across all 26 layers. Mean selected-label loss across all 180 training rows decreased from **3.2808412340 to 1.6308661991**. Adapter weights changed, and fresh checkpoint reload reproduced probabilities across all 180 rows with maximum difference **0**. The adapter SHA-256 is `a6e5c3d293640341ed2ea00fdc2b774573aab3b4db961a98371b46c7b438abc3`. Optimization took 46.655 seconds; the complete owned CLI job took 102.307 seconds and exited 0. Evidence is `.build/rfdt-real-train-job.json` and `.build/rfdt-native-prepare/training-report.json`. The base safetensors were independently hashed at 1,999,811,208 bytes, SHA-256 `3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6`, matching the pinned Hub LFS identity. This proves actual selected-position training, loss reduction, and reload on the official checkpoint; fusion, exported-native quality, and pi student execution remain separate stages. No held-out record was inferred during training.

The first converter attempt rejected the official tokenizer's untrained image placeholder at ID 262144, beyond the text model's 262144-row embeddings. The text-only export now removes only that known placeholder, fails on unexpected out-of-range additions, preserves every trained vocabulary entry and valid special token, and records source/projected file hashes. Both tokenizers match all 180 prepared prompts and 980 answer boundaries. Float32 fusion and the unmodified pinned converter then exported F16 GGUF at 2,006,573,408 bytes, SHA-256 `ee9398c9f670d7abb8493e42736c57310cfe742fe4d3dfdede23b35c18be22e6`. A frozen C7 package kept this historical student's compiler independent of subsequent prompt candidates.

That eight-step GGUF completed the fixed 60-record native validation with zero execution errors, but failed quality: choice `0.35`, clear Noul `0.625`, Brier `0.2174535236`, score normalized MAE `0.2477375068`, and regressions 4/6. Unknown Noul uncertainty MAE was `0.0365668591`. The report is bound to the exact exported artifact and run. No permanent approval or held-out test was attempted for this candidate. This proves the actual training → reload → fusion → GGUF → native-validation path, including enforcement of failed gates.

A fresh final-student run, `rfdt-20260920051809-f2e4877e`, trained the frozen C9 compiler on exactly the 180 training records, with 90 groups and 60 rows per answer type. Validation and test branch files were empty during optimization. Input/dataset SHA-256 is `7935316728623500ca906dde371355ab9d0550deffa7797e9c3fddc43f792abd`, prepared aggregate is `ae182c28c171e864c4229870e26bc18c488f7ca2bbc625be82c5638acc81c3fe`, and the actual optimizer input is `e0dbc9d6fc907f596375d08bbe2fa659a0d62ac0054370bb7675e0a29b2bf12c`. All 180 prompts and 980 candidate-label boundaries passed native/HF parity. These are 180 supervised examples; the 980 boundaries are candidate label slots. The supplied targets are one-hot, using the soft cross-entropy objective's supported hard-label special case.

This actual offline Google run completed **64 optimizer steps** with the same batch size, accumulation, learning rate, seed, and rank-16 Q/V configuration. Mean training loss decreased from **4.2319427808 to 0.1166038990**; adapter weights changed, and fresh checkpoint reload matched all 180 rows with maximum probability difference **0**. Training took 140.49 seconds. Adapter SHA-256 is `594d5ca08f46e77302969eb27764984d3f3640fd88acf4b105436e589efb69f0`. Float32 fusion and pinned F16 conversion exported **2,006,573,408 bytes**, SHA-256 **`2796f48157fa8ef0d8c0a2d68ddf8ba92df1c0c398e0b800fe0507c717cc7144`**, model ID `jev/gemma-3-1b-rfdt-20260920051809-f2e4877e`.

The selected GGUF passed every fixed native validation gate: **60 records, zero errors, choice 19/20 (0.95), clear Noul 16/16 (1.00), Brier 0.0008087218, normalized score MAE 0.0700692142, and all six regressions**. Unknown Noul MAE was 0.0079832719. Its sole choice miss was `route-case-count-chat`. An independent CPU-only review rehashed the physical GGUF, recomputed the exact training-only extraction and prepared aggregate, checked all 60 native Metal identities, and passed the public `verifyNativeRfdtAcceptance(artifact, ['validation'])` helper. Validation report SHA-256 is `90797ef62e004add0fff96faebba25ff9650d31d0fb027d909d20e20f77f96bb`; prompt manifest remains `f95f1e1da29bcb20073e0535008ae60d7adae86630bf896e24b43a2ebb2b48e5`.

The final candidate was selected and frozen before held-out inference in `.build/rfdt-final-candidate-selection.json`. Its **single native held-out test failed the normalized score MAE gate**, returning 0.1139341655 against the 0.10 maximum. All other formal gates passed: 60 records, zero execution errors, choice 19/20 (0.95), clear Noul 16/16 (1.00), and Brier 0.0023561446. Unknown Noul MAE was 0.0430164222. The test contains no marked regression records; the six fixed regressions passed validation. The report binds selected test dataset `08a34c8e3bed6e9bfec90295beca37ac9b671abe3effc6a45fc8acc665cb7e7f` and prompt manifest `b1c3b9991a1b9e18d8d3019120f4834ca40d0610d5a0cede74de153cb4f94e29`.

The CLI correctly exited 1, the artifact-specific permanent test reservation remains, the compiler was unchanged, and transient evaluation locks/candidate registries were removed. The actual public acceptance helper rejected validation-plus-test with `Native RFDT acceptance: native test quality gates or derived scores do not pass`. Test report SHA-256 is `523db337b793debc7100f63bcc00bf7532a3213db39af394a3d58e6a37a98c56`. The run manifest was unchanged by the rejection, and `.jev/artifacts.json` was absent before and after; no approval mutation was attempted. Wrapper, CLI, native evaluator, worker, and converter processes had exited.

**The student is unapproved and is not the default classifier.** There was no repeat test, post-test tuning, or replacement of the acceptance corpus. Training, export, validation, independent review, held-out failure, public rejection, and process cleanup evidence is retained under `.build/rfdt-c9-64step*`, `.build/rfdt-c9-final-test*`, and `.build/rfdt-c9-public-acceptance-rejection-proof.json`. Implementation of the workflow is demonstrated; the agreed student-promotion acceptance gate remains unmet.

The TypeScript workflow validates targets/provenance, grouped splits, native boundaries, local teacher labels/cache, manifests, and conversion/export identities. Public approval recomputes the fixed native acceptance suite from recorded probability distributions and checks derived answers, report hashes, template, run, prepared-data identity, and exact exported GGUF. User training splits cannot replace the fixed acceptance corpus. Per-run exclusive evaluation prevents validation/test races; a permanent artifact-specific reservation prevents repeated final tests. Local artifact entries are restricted to classifier-only Gemma derivatives with pinned base lineage. Abort and output-overflow cleanup awaits subprocess close with TERM/KILL escalation and bounded retained output. Eighty-eight focused tests covered these checks; the final expanded suite below includes them.

Artifact registry updates now also hold an exclusive per-registry lock through read, merge, atomic rename, and cleanup. Concurrent or abandoned locks fail explicitly with `ERR_ARTIFACT_REGISTRY_BUSY`; there is no implicit retry or stale takeover. Four public-API regression cases prove that successful distinct-ID approvals are retained, another process's lock is untouched, failures clean up the owned lock, and failed acceptance creates no registry. Forty-four focused model/concurrency tests passed.

## Verification and delivery boundaries

The context/routing development checkpoint on 2026-09-20 passed the local
TypeScript check and build, **813 Vitest tests across 38 files**, and **161 Node
protocol tests**. An offline fresh package consumer passed library and extension
imports, public declarations, installed CLI/server entry points, and actionable
missing-model behavior. The package contained 141 files and no model weights.
These checks establish source and distribution behavior; live acceptance is
recorded separately in [the context/routing progress dossier](research/CONTEXT_ROUTING_PROGRESS.md).
No new hosted CI result is claimed for this checkpoint.

The new frozen-Gemma routing head completed all 240 TRAIN feature extractions
and a stationary TypeScript logistic fit. Its independent 1,249-check audit
found no arithmetic or provenance discrepancy. Both subsequent production
validation campaigns completed their 180 scheduled classifications, but the
completeness checker rejected every request before any model call. Both therefore
failed usefulness, and neither measures the head's accuracy. Their retained
negative evidence is in [round 1](research/routing-head-validation-round-1/archive-manifest.json)
and [source-blind V2](research/routing-head-validation-v2/archive-manifest.json).
CPU fallback timing from these campaigns is not Gemma inference timing.

The separate direct head diagnostic then completed **180 actual feature calls**,
with no errors or unrun cells and confirmed runtime disposal. It forced encoder
eligibility only for laboratory measurement. Each of the three passes routed
19/20 easy cases and 35/40 strong-required cases to fast, failing the declared
safety policy. Warm operational p95 was 260.82 ms, exceeding the 100 ms target.
An optimistic score-cutoff diagnostic could retain only 2/20 easy cases while
excluding every strong-required case. No cutoff or head was changed. The head
is unapproved; no downstream answer generation or production qualification
occurred. Exact evidence is retained in
[the direct diagnostic archive](research/routing-head-raw-validation-v2/archive-manifest.json).

The real Pi/Grok context smoke with concise instructions completed all four
sessions and the context judge with correct literal answers. Input tokens fell
from 5,262 to 3,646, while generated output increased from 240 to 483 tokens.
The two paired repetitions are too small to establish general speed or billing
gains. The subsequent 192-session campaign recorded 23 correct completed
sessions and 169 HTTP 429 failures. Its full-population performance comparisons
remain unknown, and it is not qualified. Both successful and failed runs retain
their exact executed source archives. The approved 23-extension SF smoke then
reached the model without throttling and preserved the compressed wire context,
but two of four workflows reported SF extension errors. Correct final answers
from those errored workflows do not satisfy integration acceptance.

After the harness gained bounded `session_shutdown` emission before disposal,
the next real SF smoke passed **4/4 workflows and its Grok judge**, with all 23
factories loaded, clean shutdowns, preserved original history and zero extension
or HTTP 429 errors. Prompt usage decreased 12.59%, while aggregate workflow time
increased to 1.75 times baseline. This proves the lifecycle correction and
functional path, but does not pass the performance gates. Its safe projection
and exact source archive are retained in
[SF smoke 4](research/context-workflow-sf-smoke-root-4/archive-manifest.json).

An independent fresh private GitHub clone of checkpoint `7a8f823e0375419030b08d81de81efdc580d77e6` passed **200 tests across 19 files**, including the final RFDT approval, distribution, concurrency, and subprocess-cleanup fixes. TypeScript check and formatting passed. The current v1 compatibility checker passed 72 whole-Plan and 432 answer/usage comparisons. A fresh Node26 CI-style install with dependency scripts and audit disabled passed compilation and CLI tests. The repeated fresh package consumer passed library/extension imports, public TypeScript declarations, both installed bin symlinks, and actionable missing-model doctor behavior. The checkpoint package contained 61 files, 159,942 compressed bytes and 799,670 unpacked bytes, including the Manager patch and notices, with no weights, native vendor binaries, fetched templates, logs, or private run data. Its SHA-256 was `24d7d3c980d1f45165f0a28bf1bc0b430fe5061aeac085fc0b5be16199871d26`. Subsequent source/documentation changes alter that archive identity.

[Hosted check run 35490473201](https://github.com/barretts/simple-jev-ts/actions/runs/35490473201) completed successfully for that exact checkpoint on **Node 22 and 26**, including compilation, the full tests, build, compatibility, formatting, and fresh package consumers. This proves the source/package CI lane; real GPU, autonomous provider, RFDT, and held-out evidence remain separately attributed. Subsequent commits require their own hosted CI result.

After the tokenizer export, C9 compiler, registry concurrency, and native-inspector fixes, hardened checkpoint `4d30c58d43912c76fe0e1dffd236517f730d4909` passed **231 tests across 21 files**, along with TypeScript check/build, formatting, and 72/432 exact v1 compatibility comparisons. A repeated package consumer passed all import, declaration, installed-bin, and missing-model checks. Its 61-file source payload was approximately 166 KB compressed/820 KB unpacked, excluding models and Python bytecode. The package explicitly lists the RFDT worker and requirements files so locally generated Python caches cannot enter the payload. [Hosted check run 35491463432](https://github.com/barretts/simple-jev-ts/actions/runs/35491463432) passed every configured gate on **Node 22 and 26** for that exact checkpoint. Later changes require separately attributed checks.

[Hosted run 35492465712](https://github.com/barretts/simple-jev-ts/actions/runs/35492465712) for recovery checkpoint `47d7c2e` exposed a Node 22 test timing defect: 238 tests passed, but the combined live/dead/unknown/linked ownership fixture exceeded Vitest's default five-second timeout after copying/hashing over 512 MiB and exercising a fixed retry delay. Node 26 passed its tests; matrix fail-fast cancelled subsequent gates. The fixture now has a targeted 20-second test timeout, retaining all assertions and production download deadlines. That failed run remains failed evidence, and later source/package checks are separately attributed.

A subsequent local full run during actual 31B initialization passed 242/243 tests, exposing another fixture timing assumption: the already initialized fake RPC child could be terminated by a 30 ms request deadline before logging its intentionally stalled evaluation. The focused unchanged case passed under Node 22. The fixture deadline is now 500 ms, with all stage, one-execution, no-replay, and recovery assertions retained, plus direct captured process and temporary-directory cleanup checks. Production deadlines are unchanged. The failing run remains recorded in `.build/root-final-source-tests.log`; the converged source run is separate.

After applying the same 20-second fixture timeout to all eight large range cases and completing current-format Metal startup verification, source checkpoint `ba82de592fb80b2e9014c685e708b748724740d6` passed the complete **248-test, 21-file** suite in 16.08 seconds, exit 0, while the actual Gemma 4 server was active. Node 22 and Node 26 separately passed all 48 model tests; Node 22 passed all 14 runtime tests. TypeScript check/build, formatting, and scoped whitespace checks passed. The actual native server then passed hardware confirmation with `MTL0 (Apple M3 Max)` and 61/61 offloaded layers. The current startup source/distribution hashes are recorded in `.build/private-gemma4-final/ready-executed-source-proof.json`, without overwriting the earlier preflight or failed attempts.

[Hosted run 35492993623](https://github.com/barretts/simple-jev-ts/actions/runs/35492993623) passed all configured gates for exact source checkpoint `ba82de592fb80b2e9014c685e708b748724740d6` on **Node 22 and Node 26**, including dependency installation, type checking, full tests, build, 72/432 compatibility comparisons, formatting, and fresh package consumers. Actual run/job/step metadata is retained in `.build/hosted-ci-ba82de5.json`. This successful checkpoint is separate from the earlier failed run and from any later documentation commit.

Typed-teacher checkpoint `e6b64ac24760a726f3d8a848c8e7a6a080e0cd09` passed the complete **256-test, 21-file** source suite in 14.83 seconds, TypeScript check/build, targeted formatting and whitespace checks, and all 72/432 exact v1 compatibility comparisons. The fresh current-dist package consumer also passed library/extension imports, public declarations, installed-bin help commands, and actionable missing-model doctor behavior. Its 61-file snapshot was 175,137 compressed bytes and 852,074 unpacked bytes, SHA-256 `2557b40965514f324859285b1b68867433bea8768036a273b37800aba93346d2`; this snapshot includes intermediate documentation and later documentation changes alter its archive identity. Installed RFDT/core distributions and declarations matched current dist byte-for-byte. The consumer used the offline npm cache with installation scripts and audit disabled. The frozen C9 compiler remained unchanged.

[Hosted run 35493781209](https://github.com/barretts/simple-jev-ts/actions/runs/35493781209) passed every configured source/package gate for exact teacher checkpoint `e6b64ac24760a726f3d8a848c8e7a6a080e0cd09` on **Node 22 and Node 26**, including both fresh package consumers. Job IDs are 106033077299 and 106033077352. This source checkpoint is bound to the actual repaired teacher proof and is distinct from the final evidence-document commit; final delivery reports the latter's exact HEAD and separate CI run.

Automatic approval review initially rejected `npm audit --json` because it considered sending dependency metadata to npm outside the existing authorization. After the user's explicit approval, the command completed with exit 0 and reported zero known vulnerabilities in the current dependency graph. The report is retained at `.build/npm-audit-final.json`. This is an advisory-database result, not a claim that the package has no security defects.

Earlier CPU/Metal cache/full-forward differences were `2.9647678045918724e-7` and `3.021096278511812e-8`, respectively; three native rendered prompts matched an independent Jinja2 reference including BOS and assistant prefill. Earlier real HTTP transport verified classification/alias responses, invalid-input errors, diagnostics, disconnect recovery, and explicit native failure recovery. Those baseline checks are preserved and do not substitute for new live surfaces.

Actual RFDT training, export, and native evaluation are established by the official-checkpoint runs above. The final student's failed held-out gate prevents approval and default promotion. This evidence does not establish billing savings, universal accuracy, exhaustive hardware/context parity, or public publication. Model terms remain separate from the first-party Apache license. Final delivery separately reports branch/HEAD/private remote/CI identities; the tested sf-pi commit and patch identities are recorded above.
