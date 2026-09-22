# Candidate 5 TRAIN supplement

`train-supplement.json` is source-authored TRAIN material for the separate
guardrail RFDT candidate. It does not change the default Jev classifier or the
sealed v3 corpus. The paired requests share an operation group, and their
expected actions come from the unchanged operation-policy rubric plus the
[candidate-5 interpretation](./POLICY.md), not from sf-guardrail's current
decision. The `observations` fields are independently mocked host facts; no
Salesforce, Slack, browser, or shell operation in this fixture is executed.

The supplement covers Data 360 transform validation versus creation, Slack
Canvas metadata versus deletion, shell and `herdr_pane` Salesforce reads versus
writes, independently verified sandbox versus production record operations,
bounded versus broad SOQL disclosure, Account REST GET versus POST, unresolved
org variants, and Apex trace status versus trace start. A proposed Prompt
Builder help versus Save as New Version TRAIN group remains outside this
supplement while the browser qualification corpus lacks defensible VALIDATION
and TEST risk groups.
The tree-import request contains `__C5_TREE_FIXTURE__`; the builder substitutes
the absolute path of the tracked `accounts-tree.json` before sending the
request to the mocked sf-pi host functions. Related variants remain in one
TRAIN group. Four unresolved-org variants are retained only under `heldCases`:
their guessed identity must use sf-pi's rules fallback, and the builder refuses
to pass them to the model or consult real local org authentication.

The Data 360 DLO names, Canvas ID, Slack scopes and Account record ID are
fixture placeholders;
neither external journey acceptance nor a successful Slack API response is
established here. Canvas commands refer to sf-pi's `SLACK_USER_TOKEN` name as
an unexpanded shell variable. These labels judge the requested operation
under mocked facts, not whether an authenticated service would accept it.

`scripts/guardrail-candidate5-bundle.mjs` rebuilds every supplemented risk
input with the final sf-pi host and rejects examples that hit exact policy,
are model-ineligible, repeat a reserved group/request, or collide with a
reserved coarse or related-operation signature. Existing sealed TRAIN rows
are subject to the same screen. The builder reads reserved request shape for
collision checks without reading reserved labels or emitting reserved
examples. It writes a TRAIN+VALIDATION-only bundle and an admission receipt,
both at new exclusive paths. Use the final corpus and baseline exported from
the same sf-pi commit:

```sh
node scripts/guardrail-candidate5-bundle.mjs \
  --corpus /absolute/path/to/final-corpus.json \
  --baseline /absolute/path/to/final-sf-baseline.json \
  --baseline-sha256 VERIFIED_BASELINE_SHA256 \
  --sf-pi /absolute/path/to/sf-pi-candidate5 \
  --output .build/guardrail/candidate-5/training-input-bundle.json \
  --receipt .build/guardrail/candidate-5/training-input-bundle-checks.json
```

After that receipt reports `trainingReady: true`, prepare from the same
unchanged inputs and current SF host:

```sh
npm run train:guardrail -- prepare \
  --bundle .build/guardrail/candidate-5/training-input-bundle.json \
  --receipt .build/guardrail/candidate-5/training-input-bundle-checks.json \
  --corpus /absolute/path/to/final-corpus.json \
  --baseline /absolute/path/to/final-sf-baseline.json \
  --baseline-sha256 VERIFIED_BASELINE_SHA256 \
  --sf-pi /absolute/path/to/sf-pi-candidate5 \
  --checkpoint /absolute/path/to/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752 \
  --run .build/guardrail/candidate-5
```

Preparation rebuilds the bundle and receipt in a private temporary directory
and requires both files to match byte for byte. A hand-written
`trainingReady: true` flag or a matching self-issued hash is insufficient.
Keep the original admission files and source inputs together for review.
Before training, freeze the prepared TRAIN/VALIDATION files and the empty TEST
file in a prospective plan:

```sh
node scripts/guardrail-prospective-plan.mjs \
  --run .build/guardrail/candidate-5 \
  --bundle .build/guardrail/candidate-5/training-input-bundle.json
npm run train:guardrail -- train --run .build/guardrail/candidate-5
```

The training command checks the prospective plan against the current prepared
files and repeats the source admission rebuild before any optimizer call.
Export also repeats admission verification. Neither command reads a held-out
TEST label.

Do not run this command until the sf-pi baseline passes its full coverage
checks. The current host sends browser clicks and key presses to rules fallback
because it cannot verify live reference, focus, and page evidence at scoring
and execution.
That leaves the v3 browser risk coverage gate unmet. A revised, source-pinned
qualification corpus and baseline are required before training; a proposed v4
browser addendum was held because page facts do not establish focus or layout.
The builder deliberately pins the v3 corpus SHA-256. Any future revised
corpus requires separate source and split review, then an explicit update to
that pin and the supplement's corpus identity; the builder will not silently
accept a different corpus.
The bundle receipt reports per-family labels, strict-screen holds, and
`trainingReady`; a balanced bundle is still only a training input, not a
qualified model. Human label review and live API acceptance remain separate.
For candidate 5, RFDT preparation is permitted only from this builder's
explicit `trainingReady: true` bundle and matching receipt after a sealed
revised corpus, matching sf-pi baseline, and full admission check. The current
v3 corpus cannot produce a qualifying bundle; omission of the field is not a
candidate-5 approval.

The following proposals are deliberately absent: Tooling `executeAnonymous`
because it overlaps reserved Anonymous Apex semantics; an AgentScript
authoring-bundle prerequisite and a separate REST PATCH pair that requires
an existing Account record ID;
the executed-heredoc contrast because the final host reports ambiguous org
facts and uses rules fallback;
and a distinct browser VALIDATION preview/activation pair because of reserved
semantic overlap and unresolved preview-data sensitivity. No held-out TEST
request or label appears in this supplement or its resulting bundle.

## Separate TRAIN-only RFDT systems smoke

`scripts/guardrail-candidate5-train-smoke.mjs` prepares a **non-qualifying**
research input from the 40 pinned, source-authored TRAIN supplement rows. It
replays each row through the current sf-pi Safety Kernel and risk-input builder
using the bundle builder's mocked org-fact setup. It requires a version-2,
model-eligible input with no exact policy floor, retains the nine intact
allow/confirm groups, and excludes the four held unknown-org rows. It does not
read a baseline, admission bundle, validation row, or held-out TEST row. It
does not invoke a model or execute any authored tool request. The output and
receipt are written to new private files outside the official candidate-5 run.

The script requires a read-only installed `node_modules` tree for sf-pi's
imports; it resolves dependencies from that tree without writing into the
sf-pi worktree. On this machine the sibling Jev checkout has the needed
dependencies. From the candidate-5 Jev checkout:

Choose a fresh `SMOKE` directory for each attempt; existing outputs are never
overwritten.

```sh
SF_PI=/private/tmp/sf-pi-guardrail-candidate5-20260922
SF_DEPS=/Users/bsonntag/code/simple-jev-ts/node_modules
CHECKPOINT=/Users/bsonntag/code/simple-jev-ts/.build/hf-session-1_s2hbhu/home/hub/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752
SMOKE=.build/guardrail/candidate-5-train-smoke-20260922
node scripts/guardrail-candidate5-train-smoke.mjs \
  --sf-pi "$SF_PI" --sf-deps "$SF_DEPS" --checkpoint "$CHECKPOINT" \
  --output "$SMOKE/input.jsonl" --receipt "$SMOKE/receipt.json"
```

Only after checking the receipt and dataset hash, the generic RFDT API can run
an eight-update GPU systems experiment in a fresh research directory. Its
native preparation compiles the TRAIN prompts from the original Gemma GGUF;
the optimization uses the verified original Google HF checkpoint. No export,
held-out evaluation, or candidate approval is part of this smoke:

```sh
JEV_DEVICE=metal JEV_MODEL_FILE="$PWD/models/gemma-3-1b-it-f16.gguf" \
  node dist/cli.js rfdt prepare --input "$SMOKE/input.jsonl" \
  --output-dir "$SMOKE/rfdt" --template v2
HF_HUB_OFFLINE=1 JEV_RFDT_PYTHON=/Users/bsonntag/code/simple-jev-ts/.build/rfdt-venv/bin/python \
  node dist/cli.js rfdt train --run "$SMOKE/rfdt" --steps 8 \
  --model-path "$CHECKPOINT"
```

The receipt explicitly says `qualification: false`,
`officialCandidate5Admission: false`, and
`reservedSplitScreenedInThisRun: false`. This smoke tests whether the current
runtime can prepare and optimize these reviewed TRAIN examples; it cannot
replace the browser-family corpus, full split screening, final-host baseline,
ready admission receipt, or candidate-5 qualification path above. The generic
RFDT trainer does not enforce those guardrail-specific gates.

## Sealed v3 TRAIN and validation research export

`scripts/guardrail-v3-research-export.mjs` is a separate diagnostic replay of
the sealed 693-case v3 corpus. It selects only its 312 TRAIN and 192 validation
rows, checks their group split, and obtains current risk inputs from the SF Pi
host with local mocked org detection. Authored rubric labels remain the gold;
Safety Kernel decisions are recorded separately where evaluated. The script
never emits a TEST record, request, or label. It performs no model call or
authored tool operation.

The research bundle retains all 504 selected row identities and marks browser
clicks and presses as model-ineligible rules fallback. It also records exact
policy floors, incomplete facts, and inputs rejected by the current Jev v2
scorer. The companion RFDT JSONL contains only eligible TRAIN and validation
rows with explicit split and group IDs. Both outputs are deliberately
non-qualifying: the bundle has `diagnosticOnly: true`, `trainingReady: false`,
and `qualification: false`; the strict exporter and admission path above are
unchanged. This export can compare non-browser behavior on the reviewed splits
but cannot establish full-family coverage or candidate-5 approval.

From the candidate-5 Jev checkout, choose fresh paths for every replay:

```sh
RESEARCH=.build/guardrail/candidate-5-v3-research-NEW-RUN
node scripts/guardrail-v3-research-export.mjs \
  --corpus .build/guardrail/candidate-5-diagnostic/sealed-v3-corpus.json \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --sf-deps /Users/bsonntag/code/simple-jev-ts/node_modules \
  --bundle "$RESEARCH/bundle.json" \
  --rfdt "$RESEARCH/train-validation.jsonl" \
  --receipt "$RESEARCH/receipt.json"
```

The receipt binds the physical corpus checksum, SF commit and runtime-source
hash, scorer protocol, and research code. It reports eligibility by split and
family, browser fallback counts, and the hashes of both private outputs. A
request-free aggregate from the 2026-09-22 replay is committed at
`reports/guardrail-risk-2026-09-21/candidate-5-v3-research-export-summary.json`.
That original aggregate is bound to SF `44820d21`; the current final-source
split-reviewed aggregate is
`reports/guardrail-risk-2026-09-21/candidate-5-v3-split-research-summary.json`.
The separate 40-row TRAIN supplement is not included in the v3 export itself.

The eight-update local smoke completed on 2026-09-22 using dataset SHA-256
`a3f19d40ae1caf6312d39ee0cbdd8451b4c1b893ac469cf57a015056b25344cf`.
Its prepared branches were 40 TRAIN / zero validation / zero TEST. The original
Gemma 3 1B base changed adapter weights, reduced loss from 6.493761 to
0.676923, and passed checkpoint reload in 63.62 seconds. A second source
projection on clean SF commit `44820d21` produced identical dataset bytes;
the earlier projection had already seen those SF changes before commit. These
are systems and source-replay results only, not candidate qualification.

### Nonqualifying TRAIN/validation research run

After the strict admission fails browser coverage, the separate research path
can still test the local model on the non-browser subset. Generate the v3
research export above and reproject the reviewed 40-row TRAIN supplement with
`scripts/guardrail-candidate5-train-smoke.mjs` against the **same committed SF
checkout**. Then merge their receipts into a new private output:

```sh
node scripts/guardrail-v3-research-merge.mjs \
  --base "$RESEARCH/receipt.json" \
  --supplement "$SMOKE/receipt.json" \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --output "$MERGED/merged-train-validation.jsonl" \
  --receipt "$MERGED/merge-receipt.json"
```

The merge rechecks the current SF runtime, Jev scorer, source scripts, sealed
corpus, original Google base weights, exact risk-only question shape, split
isolation and input duplication. Identical same-group TRAIN inputs are
deduplicated. Eight reviewed TRAIN groups whose operations nearly replay fixed
validation cases are withheld in full; the receipt lists their 24 row IDs.
Validation rows remain byte-identical. Shared broad tool families are reported
as a limit on novelty, not treated as an automatic label leak.
The receipt always says `qualification: false`, `officialCandidate5Admission:
false`, and zero TEST rows. The generic RFDT CLI can prepare and train from the
merged JSONL for a **research** candidate only; this does not bypass the
official `train:guardrail` admission gate. Use the original verified Google
Gemma 3 1B checkpoint, the pinned RFDT environment, and TRAIN/validation only.
The first 191/96 research preparation was abandoned at step 23 after this
split issue was found; its adapter was never exported. The corrected 167/96
research dataset starts a fresh 256-update run from the original base.

Before model evaluation, run the current SF bridge preflight against the
research export with `scripts/guardrail-v3-research-valid.mjs --preflight`.
It checks that eligible validation rows still produce the exported baseline
and model input. After training/export, the same script without `--preflight`
uses `--model` and `--registry` for shadow comparison; the receipt remains
nonqualifying and reports every fallback. The 750 ms warm deadline includes
baseline evaluation, preparation and queueing. Sub-500 ms warm p95 is an ideal;
every eligible warm call must finish below 750 ms for qualification. No
research result permits a TEST run or enforcement.
