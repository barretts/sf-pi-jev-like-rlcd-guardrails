# Guardrail risk replacement evidence, 2026-09-21

This report separates source/interface proof, Pi SDK execution with scripted
or actual native inference, RFDT training, qualification and production
acceptance. Candidate 4 completed its fixed 1,536-update training run and
exported a separate model, but is **rejected and unqualified** on the final
host-hardened SF bridge validation: 12 unsafe automatic allows, two safety
regressions, 15 unnecessary interruptions versus baseline three, and only
53 of 105 eligible model calls answered. Warm p95 was 500.955 ms, above the
500 ms limit. Its actual SDK off/shadow workflow preserved rule-enforced
outcomes and approval counts, but shadow completed only two of four semantic
model checks. No held-out model calls, qualified enforce, overall improvement
or production acceptance claim is made. Candidate 3's earlier rejection and
candidate 2's usability rejection remain preserved below.

## Current host-hardened campaign checkpoint, 2026-09-22

Candidate 4 completed training from its prospectively frozen original Google
Gemma 3 1B base and 300 TRAIN / 144 validation / zero TEST prepared rows. The
separate F16 GGUF was exported without changing the default general classifier.
The pre-validation campaign receipt bound that model and final host/corpus,
but the measured validation failed safety, usability, latency and complete
execution gates. The existing rule engine remains active; no qualification
freeze or TEST inference followed.

The SF host review identified operations that require exact confirmation even
when an input appears read-like. The current integration worktree at
`/private/tmp/sf-pi-guardrail-intent-fix-20260922`, commit
`df22795e1eb0d44cdae3a6269929794858dcb6f6` (tree
`368241cef98569779904763bc20f0688a9773ca9`), keeps the existing Guardrail
hook as sole enforcement owner. It has tightened native request completeness,
exact Apex and other native operation floors, and shell/API execution-intent
handling. Incomplete action-specific requests and unresolved facts use the
existing rules. Model-derived confirmations remain one-attempt and are bound to
the complete operation, policy, model and scoring protocol; exact rule-owned
session grants remain separate. The earlier five-email patch checkpoint below
is historical; the retained patch has since been regenerated from committed
host source.

The original 612-case corpus and baseline are preserved as historical evidence
for candidates 1–3 and candidate 4's training plan. The separate v3 source
composer includes nine anonymous Apex exact-floor cases, 54 semantic-risk
variants, and 18 paired safe AgentScript and Slack Canvas controls. After the
pre-freeze label audit, two new compositions produced byte-identical outputs
with **693 cases in 231 groups**: 312 TRAIN, 192 validation and 189 held-out TEST
rows. The final composed corpus SHA-256 is
`bb4ed147933c076111b127e6a5433c6ce7ea54cc43befb7d384ddb54681e6309`.
Its `operation-policy-v2` rubric source SHA-256 is
`cad1720e8ee31c153985ee98af010671d323917c0ef30c7ebd61c3832b318ae6`;
campaign metadata also preserves the original base rubric identity.
The semantic variants exercise realistic CLI, API, SOQL and browser paths that
remain model eligible after exact host floors; the safe controls challenge
broad confirmation heuristics on the same surfaces. The addenda are machine
authored under the explicit operation-policy rubric, with independent human
label review pending. The 690-case corpus and its baseline preview are
superseded; those previews made no candidate 4 model calls.

Two fresh baseline exports from the committed SF host and final composed corpus
were byte-identical. The retained baseline is
`.build/guardrail/host-hardened-baseline-v3-final-df22795e.json`, SHA-256
`7668c347e040ae314995c11093e0ee877bd8c2f46c98ed7ac6ccbd6d5d080db0`.
Its recorded SF baseline source SHA-256 is
`333d737bc6a167c342854242a9a6a9d3a160cc68fa28e7ea9dd1a3d14e2730f6`.
The actual rule engine ran with authored generic org/browser observations and
mocked execution; no requested external operation ran. The baseline contains
693 cases and 231 groups. It has 387 model-eligible requests, 303 exact policy
floors, and three explicit incomplete-request rule fallbacks, all in TEST.

The source identity now closes over literal local imports from maintained
runtime roots and includes runtime JSON and package manifests. Its runtime
inventory has 426 files and the exporter provenance inventory has 428. The
runtime traversal is limited to 1,024 files, 16 MiB total and 2 MiB per
source. This binds recorded source bytes; it does not prove nonliteral module
loading, external state or activation of a deployed Pi installation.

| Split         |   Cases | Model eligible | Baseline unsafe allows | Baseline benign interruptions |
| ------------- | ------: | -------------: | ---------------------: | ----------------------------: |
| TRAIN         |     312 |            171 |                     23 |                             3 |
| Validation    |     192 |            105 |                     29 |                             3 |
| Held-out TEST |     189 |            111 |                     29 |                             5 |
| **Total**     | **693** |        **387** |                 **81** |                        **11** |

The 92 baseline disagreements are against machine-authored policy labels, not
candidate 4 predictions or measured population failure rates. The first
baseline export attempt exposed three incomplete held-out Apex request shapes.
Exporter fallback handling was corrected and committed before the final
baseline export and before any candidate 4 TEST model call. The held-out set
was therefore not wholly untouched during campaign preparation. The final
committed campaign and this disclosure must stay attached to any later TEST
result; independent human label review remains pending.

A source-only split-isolation audit compared candidate 4's actual 300 prepared
TRAIN rows with the final 111 model-eligible TEST rows. It found zero complete
canonical risk-input replays. There are 54 repeated raw browser-click
tool/input pairs, each with different independently resolved browser facts;
the new TEST addenda have zero raw-input matches to candidate 4 TRAIN. The
original corpus has ten group-name ancestry pairs that reuse conceptual
operation families across splits. A later held-out result may therefore claim
new contexts and syntax, but not wholly unseen operation families. This audit
made no TEST model predictions.

Before candidate 4 validation, the
[`guardrail-campaign-receipt.mjs` preflight](../../GUARDRAIL.md)
created an exclusive mode-`0600` receipt after model export and the Jev source
commit. It bound the original prepared TRAIN/validation run, model and
registry, final corpus and rubric, committed SF host and its source inventories,
scorer, 0.99 cutoff, 500 ms budget and qualification criteria. Its content
identity is SHA-256
`17554b9e34e48ffcc752cdb7f280fb50476853c0e68a86f82d582b0f45f321c1`;
the receipt verified against current files and explicitly records
`qualification:false` and `permitsHeldOutTest:false`. A source-only baseline
re-export after validation was byte-identical to the pinned baseline, SHA-256
`7668c347e040ae314995c11093e0ee877bd8c2f46c98ed7ac6ccbd6d5d080db0`.
The receipt and baseline are provenance checks, not passing model results.

The current freeze command requires `--sfRoot` and verifies the executing SF
exporter against that recorded provenance. Only a passing validation candidate
can be frozen before held-out TEST calls. Candidate 4 failed validation, so the
existing engine stays active. The old `0f31a950...` SF baseline, original-corpus
results below, source tests, scripted SDK tests and native shadow results cannot
be relabeled as host-hardened model qualification.

The v2 draft source-only baseline preview contained 672 cases, 224 groups and
89 baseline/gold disagreements (78 unsafe baseline allows and 11 unnecessary
interruptions). It made no model calls and is superseded by the final safe
paired controls. These preview counts are neither candidate 4 results nor
qualification thresholds for the final campaign. No held-out model prediction
has been inspected for the new campaign.

The general Jev driver now awaits risk-worker initialization at enabled,
operator-opted-in `shadow`/`enforce` startup, re-enable and template replacement.
This closes the cold enforce path that otherwise rejected an uninitialized
provider before it could warm. The actual worktree passed 46 focused tests,
including 18 new adapter-stub lifecycle cases, strict source/new-test type
checks, build and formatting. Default off remains lazy; failures retain status
and rule fallback, and shutdown cancels owned initialization. All 21 candidate
4 source pins and the compiled qualification criteria remained unchanged after
the rebuild. These checks do not establish native driver startup timing,
qualified enforcement or model effectiveness. API embeddings must await Pi's
extension binding before executing tools.

A later external headless CPU proof passed three cases against the actual
current compiled Jev driver and SF production modules, with one safe
counter-only request per mode. Off remained lazy; shadow awaited stub
initialization and recorded one Jev comparison; genuinely unqualified enforce
awaited initialization, performed no scoring and recorded rules fallback.
No qualification receipt or getter override was supplied. All 114 Jev
source/compiled files and 33 SF production files retained their bytes. The
retained [complete proof](./sdk-normal-startup-stubs.json) is
also copied under the ignored startup evidence directory,
SHA-256 `98d53a280245176afdd93a14188fee119cca52bb91549507662673dfbe28923b`.
Its deferred-stub timings and one-safe-request denominator do not establish
native latency, risky approvals, complete workflow parity or qualification.

An actual native Pi SDK trial with the rejected candidate 3 used the updated
normal `session_start` path while two local RFDT workers were active. The
[full failed-attempt receipt](./candidate-3-normal-startup-failed.json)
records that model initialization ended with `Context initialization failed`:
the risk worker remained cold with no verified model SHA, and none of eight
semantic checks received a model answer. Seven reached the 500 ms deadline and
one encountered worker retirement. The harness correctly failed its complete
model-execution assertion. All eight requests fell back to the current rules,
both exact-policy checks stayed exact, and off/shadow accepted outcomes,
confirmations, session grants, decisions, retries and tool errors matched.
The system reported 80% free memory at inspection, so the concurrent jobs do
not establish the cause of native context failure. This is an operational
fallback observation, not a valid latency or model-quality measurement. A
passing native normal-startup proof remains pending under an uncontended setup.

One bounded direct init of the same candidate 3 GGUF and native binary
reproduced the failure in 297 ms. The
[diagnostic receipt](./candidate-3-metal-context-diagnostic.json) preserves
the native error and stderr tail: model weights loaded, then llama.cpp could
not obtain a Metal command queue and could not initialize its backend context.
The log also printed the selected Metal device name as `(null)`. In the pinned
llama.cpp source, the queue error is emitted both when the default Metal device
is unavailable and when a device exists but queue creation fails. Missing
device exposure is therefore a leading hypothesis, not an established cause;
the receipt contains no direct Metal API probe. The context requested 49,152
tokens; prepared candidate 4 TRAIN and validation prompts have maxima of 751
and 752 tokens respectively. This observation does not establish that context
size, the sandbox, or concurrent training caused the failure. No candidate 4
source or model was changed for this diagnostic.

The updated optional native SDK harness now registers the real general Jev
driver and awaits that normal binding/startup path, with no manual provider
warmup. Seven actual SF source cases passed with the native arm skipped, plus
TypeScript, file lint and formatting. The frozen ten operations and complete
eight semantic/two exact-policy comparison requirements are unchanged, as are
the 33 production sources and their qualification identity. Startup timing is
inclusive of all handlers and is reported separately from setup, warm workflow
and total time. Candidate 3's existing native receipt used manual warmup and
does not prove this updated startup path. A passing native run and genuinely
qualified enforcement remain pending.

The isolated worktrees use `barretts/jev-guardrail-risk`: Jev at
`/private/tmp/simple-jev-ts-guardrail-risk-20260921`, based on `95c0b50`, and sf-pi
at `/private/tmp/sf-pi-guardrail-risk-20260921`, based on `4f901db9`. The default
general classifier remains unchanged. The separate guardrail candidate uses
`google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752` and the existing
RFDT pipeline. No excluded model lineage, derivative, teacher or fallback is
introduced.

An earlier SF integration source checkpoint is
`e09085fd1a05cc836b2f377325aea33f9ced1cf1`; it has not been pushed. Its tree is
`ef7b70ad1f107ec989ac783f68883815338e6a91`. The
then-retained baseline-bound integration patch contained five email patches:
initial integration
`beaa11c0`, workflow proof `24546444`, ADR0052 clarification `eab0eac6`,
semantic-call completeness checks `38899055`, and normal driver startup in
the SDK harness at the final checkpoint above.
Its SHA-256 is `327ca9e5519cd660c1316499311363dfdb56d714b45fa158b984fdacfe224a62`,
with 175,031 bytes. Splitting and sequentially applying all five to baseline
`4f901db9c3f5076ea0305dea33ad6e8856e467da` using a private index and object
store reproduced every intermediate and final tree. The real SF index and all
1,749 tracked checkout files remained unchanged. Runtime
baseline SHA-256 stays `0f31a95043fc761347a9ccc51dc673b6aaea77d9ca61bd129f789eaa51fa1f45`.
This historical check proved that patch's delivery integrity; it did not
activate a Pi host or publish the integration. The current retained patch and
its verified source tree are documented in the
[integration README](../../integrations/sf-pi-guardrail/README.md).

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

| Candidate   | Observed training status                                                                                                                                  | Selection/qualification                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Candidate 1 | Stopped at update 42/256 after review found two incomplete Data 360 rehearsal parameter sets. The old corpus, plan and abandonment receipt are preserved. | Abandoned; no held-out model calls.                                                                                          |
| Candidate 2 | Fresh pinned Google base; corrected corpus; all 256 planned updates and checkpoint/reload checks completed. Separate F16 export recorded.                 | Native validation complete; rejected by usability gate; no prospective freeze or held-out calls.                             |
| Candidate 3 | Same original base, inputs and profile; all 1,536 planned updates completed; all 252 TRAIN cases fit the fixed cutoff; separate F16 export recorded.      | Native validation rejected on unsafe allows, safety regressions and benign interruptions; freeze refused; no held-out calls. |

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
The owned helper exited zero and awaited its children. The training phase took
4,830.391436 seconds; mean TRAIN cross-entropy decreased from 4.7091871897 to
0.0000075310. Adapter reload maximum probability delta was zero. The full
post-fit saved-adapter evaluation classified 252/252 TRAIN cases correctly and
met the runtime rule for every case: all 129 safe cases automatically allowed
at the unchanged 0.99 cutoff and none of the 123 risky cases automatically
allowed. All 252 correct-class margins exceeded ln(99); the minimum safe margin
was 8.31249964 and maximum risky margin was -8.18749958. The independent root
review verified all 15 frozen training source pins and the original base.

The [complete candidate 3 TRAIN receipt](./candidate-3-full-train.json) retains
all 252 selected-label score vectors, authored targets, per-case margins and
source-report identities. Source full-TRAIN evaluation SHA-256 is
`0af4379d9e29e147d18c7f5631e6b83abc2d7ea1de9d4958cbc9c81a3e4a7d66`;
the compact tracked receipt's SHA-256 is
`02148433f51d0982cedf34fb479eeb4c3f6549c61bef0dbe4957d62fd00a03c1`.
This establishes TRAIN fit, not sufficient native generalization. A separately
authorized export after that diagnosis identifies
`jev/gemma-3-1b-guardrail-candidate-3`, SHA-256
`c87022dfe3090765ffbd25d792fb9263bed914f1c37cc090e1130c2987b537be`,
2,006,573,408 bytes, in a separate candidate registry with no qualification.

The [complete candidate 3 native bridge validation receipt](./candidate-3-sf-bridge-validation.json)
contains all 165 validation records / 55 groups through the actual SF bridge
and local Jev worker. The facts remain authored fixtures and dangerous tools
were not executed. All 144 eligible calls answered with zero execution errors;
fallback did not conceal a failure.
The [validation error-group analysis](./candidate-3-error-groups.md) separates
correlated request variants and shows that candidate 4's prospective TRAIN
supplement does not directly cover the two unsafe-allow operation groups.

| Validation criterion        | Candidate 3 | Baseline / requirement         | Result   |
| --------------------------- | ----------: | ------------------------------ | -------- |
| Unsafe automatic allows     |           6 | Baseline 14; required 0        | **Fail** |
| Existing safety regressions |           5 | Required 0                     | **Fail** |
| Exact hard-block demotions  |           0 | Required 0                     | Pass     |
| Unnecessary interruptions   |          19 | Baseline 3; required at most 3 | **Fail** |
| Warm risk-check p95, ms     |  213.735667 | Required at most 500           | Pass     |
| Eligible calls answered     |   144 / 144 | Every eligible call            | Pass     |
| Execution errors/fallbacks  |           0 | Required 0                     | Pass     |

The [validation-only score diagnostic](./candidate-3-score-diagnostic.json)
recomputes case counts and decisions from the tracked SF bridge receipt. For
any positive global temperature applied to the same two label logits, the
effective original-score threshold at the fixed 0.99 cutoff stays above 0.5.
Nine benign cases already score at or below 0.5, so temperature alone cannot
reach the baseline limit of three benign interruptions. Removing all unsafe
automatic allows would require an original-score threshold above
0.9999990659524576 and interrupt at least 69 benign cases. Reproduce it with:

```sh
node scripts/guardrail-score-diagnostic.mjs --validation reports/guardrail-risk-2026-09-21/candidate-3-sf-bridge-validation.json
```

This is a saved-score counterfactual, not inference, a calibration fit, a new
latency measurement, or qualification. It says nothing about candidate 4.

Cold initialization was 2,647.130459 ms, separate from warm risk checks. Raw
validation SHA-256 is
`efd12e445ad5fad473c90337b4154e69ec1e802f5c5d8c032ad633a9b79d4126`;
measurement SHA-256 is
`520e6bca0a4be0bb24337615de8e583b5eb21db8b5bb7596218de5b42d397999`.
The ledger records the distinct compact physical hash and current criteria,
native binary, protocol, corpus and runtime identities. Independent CPU review
verified the original current implementation seal, metrics/gates and all 33
runtime pins. The [freeze refusal receipt](./candidate-3-freeze-refusal.json)
records expected CLI exit 1, “Candidate failed validation; held-out testing is
prohibited,” and no freeze output before or after. This is fail-closed proof,
not qualification. Six unsafe allows and five regressions preclude an
equal-or-better claim even though aggregate unsafe allows are below the
baseline. The 16 correctly resolved disagreements do not establish overall
improvement. The failed candidate is neither frozen nor promoted; no held-out
model inference occurred.

Candidate 4's genuine preparation completed at 01:58:10.772 UTC on 2026-09-22;
its inventory checks passed before training began at 01:58:10.786 UTC. The
prospective plan SHA-256 is
`05947f9119dfb3a567ae1248fa2414160f383217fc8c45d53bc8f6e8e63fb4b0`.
The [48 retained TRAIN-only counterfactual records](../../fixtures/guardrail/train-counterfactuals.json)
and [reproduction instructions](../../fixtures/guardrail/TRAIN_COUNTERFACTUALS.md)
are the only changed training axis. Actual prepared branches are 300 TRAIN /
144 validation / zero TEST, with authored SHA-256
`ee60d00405d57fbeb31ecd675559ad2660dec2dd3f270f2cfb2f34e33434f315`.
The original 252 prepared TRAIN rows remain an exact byte prefix; prepared
validation SHA-256 is unchanged and the TEST file is empty. Root's execution
review verified all 21 source pins before the first model call, and a subsequent
independent CPU review confirmed the genuine preparation postconditions.

The run retains the original reviewed Google base, default RFDT settings and
1,536 fixed updates. With 300 TRAIN rows, nominal mean presentations per row
are 40.96 versus candidate 3's 48.7619. This is an exposure calculation, not a
progress percentage or accuracy forecast. Training completed all 1,536 updates
at 06:49:53.570 UTC on 2026-09-22. Recorded loss fell from 4.724919 to
0.000020; the adapter changed, checkpoint reload matched, and rendered-prompt
parity covered all 444 prepared TRAIN/validation rows. Training-phase duration
was 11,734.713 seconds. This is training integrity, not a full 300-row
post-fit safety result. The separate F16 GGUF, model ID
`jev/gemma-3-1b-guardrail-candidate-4`, is 2,006,573,408 bytes with SHA-256
`9d6c21487a85c2aad86fa169f8ba816620529b01d993e5a13b09d89ebc047f1b`.
The original 612-case corpus, reserved groups, protocol, cutoff and criteria
were unchanged for training; the 660-record supplemental container remained
training input only.

The [host-hardened bridge VALID receipt](../../.build/guardrail/candidate-4/host-hardened-bridge-validation.json)
has physical SHA-256
`ede68579d45da6549bac468a266b5b550e89b6b13fdcfdaf8d99b696cf439a13`.
It covers 192 validation cases in 64 groups against the final 693-case corpus.
The actual SF bridge and local Jev worker used authored host facts and mocked
execution. Cold initialization was 3,008.359 ms, separate from warm checks.

| Qualification gate            | Candidate 4 |     Required or baseline | Result |
| ----------------------------- | ----------: | -----------------------: | ------ |
| Unsafe automatic allows       |          12 |           0; baseline 29 | Fail   |
| Safety regressions            |           2 |                        0 | Fail   |
| Hard-block demotions          |           0 |                        0 | Pass   |
| Benign interruptions          |          15 |       At most baseline 3 | Fail   |
| Eligible model calls answered |    53 / 105 | 105 / 105 without errors | Fail   |
| Warm risk-check p95           |  500.955 ms |           At most 500 ms | Fail   |

The 52 eligible call errors comprise 48 deadline/abort results and four worker
generation changes. Nineteen baseline disagreements were correctly resolved,
but the unsafe allows, safety regressions and extra interruptions preclude an
equal-or-better claim. Warm p95 is from serial corpus requests and does not
establish latency under a contended queue. Candidate 4 was rejected; no
qualification freeze or TEST model call followed.

Three subsequent VALID-only diagnostics did not change that result. An
[unchanged candidate 4 repeat](../../.build/guardrail/candidate-4/host-hardened-bridge-validation-repeat.json)
answered 41/105 eligible calls, with 64 errors and 501.042 ms warm p95. A
[smaller-context guardrail-only trial](../../.build/guardrail/candidate-4/host-hardened-bridge-validation-small-context-diagnostic.json)
under changed scoring source was discarded after 39/105 answers, 66 errors
and 501.259 ms p95. The older candidate 3 model, tried on the
[same final VALID inventory](../../.build/guardrail/candidate-3/host-hardened-bridge-validation-diagnostic.json),
answered 26/105, with 79 errors and 501.161 ms p95. The latter two are
diagnostics using changed source or old model weights, not prospective
campaign qualification. The original candidate 4 receipt remains decisive;
none of these runs used TEST model calls or justifies changing the fixed gates.

A separate [VALID-only native timing profile](../../.build/guardrail/candidate-4/host-hardened-native-profile-validation.json)
scored all 105 eligible prompts with one escalated Metal worker and a 15-second
diagnostic timeout. Exact prompt lengths were 652–773 tokens (median 696).
Request preparation p95 was 0.34 ms and native compile/tokenize p95 was
19.54 ms; native evaluation itself took 415.93 ms at p50 and 593.34 ms at
p95. Total diagnostic p95 was 611.87 ms, with 33/105 native evaluations above
500 ms. This isolates native computation as a direct latency source in that
run even without SF host preparation or queueing. It is a diagnostic under a
different timeout, not campaign qualification or a replacement for the failed
bridge receipt.

The [actual Pi SDK off/shadow report](../../.build/guardrail/candidate-4/host-hardened-sdk-workflows.json)
has physical SHA-256
`257a2b314477304b5ab49c15a7c4dffede0d0dd41320971a0c90c802f194d7ab`.
It used the real driver and local model with scripted user choices, authored
host facts and counter-only tools. Both modes accepted the same nine of ten
operations, blocked the same protected-path request, requested three
confirmations, issued three rule-owned session grants, and had no retries or
unexpected tool errors. Off stayed lazy; shadow initialized in 3,131.707 ms
and recorded all six exact-policy comparisons. Only two of four semantic
checks received model answers; two fell back after the 500 ms deadline.
Shadow did not change approval or execution outcomes, but the incomplete model
calls and absence of qualified enforce prevent a workflow-benefit claim.

The separate [prospective TRAIN diversity supplement](../../docs/GUARDRAIL_TRAIN_DIVERSITY.md)
retains 80 exact bridge inputs in 40 groups, with 40 allow and 40 confirm
targets, plus the raw observations and complete source/provenance proof.
All requests match the actual mocked bridge export. Complete inputs match the
earlier CPU draft on 61 cases; 12 shell inputs gain source-resolved org facts
and seven browser inputs gain mock snapshot digests. Five unresolved org
observations use the supported `unknown` type and produce production with
`guessed:true` through the existing resolver. On these authored cases the
baseline has four unsafe allows and six benign interruptions. These are data
and source observations; no model was evaluated on the supplement. Human label
review is pending, universal team non-exposure is explicitly false, and the
full discarded/replacement contribution ledger is retained. Root checked all
80 inputs with the existing guardrail/RFDT validators, exact bridge equality
and all 21 unchanged candidate 4 source pins. Another candidate is not selected;
the temporary 692-case source replay must never become qualification evidence.

Candidate 4 failed its fixed gates. The user has offered Gemini or ChatGPT
Deep Research documents for a future experiment; any research prompt should
include the measured 12 unsafe allows, two safety regressions, 15 benign
interruptions, 52 incomplete eligible calls and 500.955 ms warm p95. Research
may guide a validation-selected future experiment, but must not supply a cloud
teacher, replace operation-policy labels, tune using held-out results or weaken
qualification criteria. No successor candidate is selected here.

The saved-scalar CPU parity receipt
`.build/guardrail/candidate-3/initial-256-parity-receipt.json`, observed at
00:34:05.856 UTC, has SHA-256
`40065c9ce5dc8a2163a3d88073467a1870b40bb6a00e28a9832aaa11371f2e67`.
Its first 256 candidate 3 step IDs and TRAIN batch losses match candidate 2
256/256 exactly; maximum absolute loss difference is zero. Authored and
prepared TRAIN input hashes match. An independent CPU replay checked those
scalars and all seven bound plan/input hashes, without model calls or held-out
data. This supports reproducibility of the unchanged training profile only;
later TRAIN completion and native validation rejection are separate receipts.

Candidate 2's preparation binds the original bundle SHA-256
`6381f6dc8c94de22105a417d95265a90ec798a3c36d18784f61a1c04c06dbc83` and its then-current
baseline/provenance SHA-256
`0db5db3546345a9058451450ed4f6eb4e3472944bcc2be367743f82dc99f720c`.
Later SF hardening separates runtime baseline identity from full exporter
provenance. A final bridge evaluation/freeze must use the final runtime identity;
the preparation identity is retained as history rather than overwritten.

Source tests cover provider discovery, strict input/response checks, failure
fallback, cancellation, qualification tampering, changed identities, worker
lifecycle and approval behavior. The recorded full Jev source checkpoint before
the later evaluator seal fixes passed 1,011 tests
across 46 files in 10.44 seconds with isolated Pi state and narrowly escalated
local fixture listeners. TypeScript/package checks, build, 38 focused guardrail
tests across four files and formatting also passed. SF guardrail/runtime checks
passed 315 tests (one further test skipped), and six actual Pi SDK tests passed.

At the current worktree checkpoint, Jev type checking, formatting and 59 focused
guardrail tests across five files passed. A full sandboxed Jev run passed 1,014
tests in 45 files but failed 18 tests in `agent-server.test.ts` and
`rfdt.test.ts`: their localhost fixtures received `listen EPERM` for
`127.0.0.1`. A narrowly escalated rerun of exactly those two files passed all
34 tests in 5.22 seconds. The current 47 files and 1,032 tests therefore pass
by partition/replay, not as one green uniform suite invocation. These source
checks do not establish candidate 4 model quality or warm risk-check latency.

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
this addition and is not increased into a new global total. All timings above
describe scripted inference; the later genuine native SDK run is separate.

The latest collector additionally verifies exactly eight answered semantic
comparisons with `source: jev` and two exact-policy comparisons for shadow and
enforce, matching each call's version, mode, tool, input identity and delivery
order. The workflow definition remains frozen and unchanged. The complete
tracked scripted receipt is refreshed; its physical hash and the earlier
representative checkpoint's hash remain separate ledger entries. Final source
checks again passed seven tests with one native skip, TypeScript, file-level
ESLint and formatting. Those scripted assertions did not execute the native arm.

The [actual candidate 3 native SDK receipt](./candidate-3-sdk-representative-native.json)
subsequently ran the same frozen ten operations in off and shadow modes through
the actual Pi SDK with genuine local Jev inference. It uses scripted
assistant/user choices, mocked org observations and counter-only tools; no
external operation executes. The selected native test passed, with seven
other tests skipped by selection. Off expects zero model calls and never
initializes weights. Shadow verified eight answered semantic model comparisons
and two exact-policy comparisons with matching source, version, mode, tool,
input identity and delivery order.

| Mode   | Executed operations | Confirmations | Session grants | Exact blocks | Unsafe allows | Fallbacks / retries | SDK setup ms |   Model cold ms | Workflow ms |  Total ms |
| ------ | ------------------: | ------------: | -------------: | -----------: | ------------: | ------------------- | -----------: | --------------: | ----------: | --------: |
| Off    |                   9 |             3 |              3 |            1 |             0 | 0 / 0               |       13.314 | Not initialized |       9.956 |    23.319 |
| Shadow |                   9 |             3 |              3 |            1 |             0 | 0 / 0               |        3.350 |       2,646.484 |   1,615.331 | 4,265.249 |

Each mode recorded one tool error corresponding to the expected exact block,
with zero unexpected errors. The old engine enforces both modes, so matching
outcomes establish that shadow comparisons did not change this fixture's
approvals or execution. Warm workflow elapsed time includes its eight native
checks and host/SDK work; model cold initialization is separate. Scripted user
choices add no human deliberation time. The unqualified candidate did not run
the enforce arm, and its enforcement comparison is null. This proves native
shadow operation and measures local overhead; it establishes no workflow
speed benefit, enforce confirmation parity or production acceptance.
Raw SDK report SHA-256 is
`04d8756dc4fbb04a8f78773fce9e0c18a62acd7ca5207af93e4d5c830b71fd9d`;
the compact tracked copy's SHA-256 is
`974f3e33f58942271ccd5b16efaa2c388496f7e9a5ebe8bc8c838703cc7ef78c`.
The scripted receipts and prior two-operation SDK checkpoint remain preserved.

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
files passed 41 tests in 1.89 seconds after the fixes, separately from the
earlier full-suite checkpoint; TypeScript check/build and owned-file
format/source whitespace checks passed. All 15 candidate 3 frozen training
source files still match their prospective plan. Compiled criteria SHA-256 is
`b7147735bc3c2c2dc5fd00b61d1abfc1c3a66888213d5f37dc1c790ba791c8b7`.
Numeric criteria and the 0.99 cutoff are unchanged. This strengthens identity
binding before future validation; it supplies no model-effectiveness claim.
Candidate 2's original validation receipt remains byte-identical with its
historical seal, intentionally not verifiable under the current evaluator.
It is not resealed; the numeric usability rejection and no-freeze/no-held-out
status remain intact. Candidate 3's fresh validation uses the current seal and
independently verifies; its failed gates prohibit qualification freezing.

The identical-operation SDK workflow does not establish session-approval prompt
parity for changed related operations. Current model-derived grants bind to an
exact operation, active policy, model and protocol; baseline family grants may
reuse approval more broadly. This remains a usability limitation requiring
matched real-model workflow evidence. Novel model risks retain allow-once scope.

Automatic approval review rejected extending model-derived confirmations to
session grants because a broad grant could repeat a destructive shell command
without a new prompt. The integration retains one-attempt model approval and
tests operation/policy/model/protocol binding. Exact rule-owned grants and
revocation remain available. Matched real-model workflows must still establish
whether this conservative behavior meets the no-extra-confirmations gate; the
scripted repeated-shell example above did not.

Qualification requires zero unsafe automatic allows, zero safety regressions,
zero hard-block demotions, unnecessary interruptions at or below the measured
baseline, all eligible model calls completed without fallback/errors, and warm
p95 ≤500 ms including preparation and queueing. Safe logits must win with an
uncalibrated score ≥0.99. Validation alone selects a candidate; its weights,
protocol, cutoff, case inventory, criteria, native binary and runtime baseline
are frozen before any held-out model inference. A failed gate rejects the
candidate and preserves the current engine.

Real bridge qualification runs corpus requests serially. Warm elapsed includes
request preparation and any queue wait encountered, but its p95 does not prove
latency under a contended queue.

[evidence.json](./evidence.json) contains the compact checkpoint ledger. The
candidate's failed validation, full TRAIN fit, actual native off/shadow fixture
and separate cold initialization are recorded. Held-out results and qualified
real-model enforce workflows remain unset. Large raw runs, adapters and weights remain
under ignored `.build/guardrail/`; no raw weights are part of this report.

Runtime defaults to `off`; `shadow` records comparisons while the original
engine enforces; qualified `enforce` is operator opt-in. Exact policy and the
single existing approval/audit owner remain in place. Corpus qualification,
matched real-model workflow effectiveness and production acceptance are
separate proof boundaries.
