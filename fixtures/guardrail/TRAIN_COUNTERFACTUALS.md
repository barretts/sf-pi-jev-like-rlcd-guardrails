# TRAIN counterfactual supplement

[train-counterfactuals.json](./train-counterfactuals.json) retains 48 supplemental
TRAIN records for prospective candidate 4: 24 matched pairs, with 24 `allow`
and 24 `confirm` targets. These are machine-authored operation-policy labels;
human label review remains pending. Every record has exactly seven fields:
`id`, `groupId`, `family`, `split`, `expected`, `modelEligible` and `riskInput`.
Every split is `train` and every record is model eligible. No baseline label,
policy floor, existing-engine reason, audit or tool execution result is supplied
for these auxiliary records.

The source is the sealed TRAIN-only contingency draft at
`/private/tmp/guardrail-train-counterfactual-draft`, constructed from existing
TRAIN parents while candidate 3 was still training. Its corrected independent
root-agent review is dated 2026-09-22 01:04 UTC, before candidate 3 native
validation. That review processed reserved inputs only for schema validation
and canonical hashing; it did not review their semantics, gold labels or model
predictions. The sealed draft was not selected or applied at that checkpoint.
These records were later copied, in their original order, from the final 48
rows of `/private/tmp/guardrail-candidate4-training-bundle/training-input-bundle.json`.

| Matched axis               | Pairs | `allow` operation-policy target                          | `confirm` operation-policy target                                                                                 | Retained TRAIN parent group                              |
| -------------------------- | ----: | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Data 360 execution intent  |     6 | `stream.create_ingest_api` with explicit `dry_run: true` | The same request with `dry_run: false`, allowing a live mutation                                                  | `train-data360-data360_prepare-stream.create_ingest_api` |
| Salesforce org observation |     6 | Deployment with independently observed sandbox facts     | The identical deployment request with independently observed production facts                                     | `train-salesforce-known-dev-deploy`                      |
| Browser observation        |     6 | Click with fresh observed button label `Cancel`          | The identical click request with fresh observed button label `Save`, despite its supplied `mutation: false` claim | `train-browser-cancel`                                   |
| Shell execution intent     |     6 | `printf` displays quoted `rm -rf release/` text          | `bash -c` executes the same removal text                                                                          | `train-shell-quoted-remove`                              |

Six synthetic aliases, references or environment wrappers provide nuisance
variants per axis. Both members and all variants retain the same existing
TRAIN parent group. No original group moves between splits. The explicit
rubric follows the distinctions in [RUBRIC.md](./RUBRIC.md): observe the
operation's execution intent and independently supplied org/browser facts;
tool-supplied approval or harmless-intent claims do not authorize mutations.

Org and browser facts come from independent mocked fixture-host observations,
not from existing rule classifications. They are authored facts, with no live
Salesforce org or browser verification. Org facts carry `guessed: false`; bash
org facts include their full command. Native-tool org facts omit the command.
Browser facts retain only their fresh status, role and label. Optional org
names and browser URL, snapshot digest and capture age are omitted exactly as
in the sealed source. Shell facts are empty. These omissions are intentional
training-input variants, not fabricated observations. Source review checked
the Data 360 action, required body and dispatch semantics; it did not prove
nested server acceptance.

The independent CPU review checked 285 reserved eligible inputs, all 285
canonical hashes unique, with **zero supplemental hash collisions**. It also
confirmed 48 unique supplemental inputs and decision-driver-only differences
within all 24 pairs. This does not establish a statistical generalization or
model-effectiveness result. The original [612-case qualification corpus](./corpus.json),
validation/held-out groups, gold rubric, baseline, protocol, 0.99 cutoff and
numeric gates remain unchanged. Qualification must use that original corpus
and baseline, without these auxiliary rows.

The reviewed temporary training-input bundle has 660 records and SHA-256
`acc33f57d031e0e1e86483cbc81f3daeb5a263cc48dadcb67e1b9ee546d5d89c`.
Its original 612 records and all original header values are preserved. Its
header and baseline summary therefore continue to describe the original
612-case baseline; they do not assert a baseline measurement for 660 cases.
The appended bundle is **TRAIN input provenance only**, not qualification
evidence or a new baseline. The new fixture retains the exact 48 seven-field
records; JSON formatting does not change their values or order.

The CPU conversion reproduced the unchanged `guardrail-train.mjs prepare`
mapping: 444 authored examples, comprising the original 396-row byte prefix
and 48 additional TRAIN rows. Expected authored SHA-256 is
`ee60d00405d57fbeb31ecd675559ad2660dec2dd3f270f2cfb2f34e33434f315`.
Expected branches are **300 TRAIN / 144 validation / zero TEST**. The original
252 prepared TRAIN rows and 144 validation rows must remain unchanged. Expected
prepared validation SHA-256 is
`889ced806d4e9fd307bd980f8bbadab4dcf09c8b435bb79db6103a9be12a622c`.
Those are admission gates for genuine preparation, not an assertion that native
preparation or candidate 4 training has completed. The reviewed CPU bundle
construction made zero model, native preparation, training or export calls.
True preparation and training remain pending at this fixture checkpoint.

To reproduce the training input, first obtain the independent original engine
baseline bundle using the existing exporter described in
[GUARDRAIL.md](../../GUARDRAIL.md). Clone that bundle into a new file and append
the retained fixture. This recipe leaves the original baseline untouched and
does not run a model:

```sh
export JEV_REPO=/private/tmp/simple-jev-ts-guardrail-risk-20260921
export BASELINE_BUNDLE="$JEV_REPO/.build/guardrail/baseline.json"
export TRAINING_INPUT_BUNDLE="$JEV_REPO/.build/guardrail/counterfactual-training-input.json"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
const baseline = JSON.parse(await readFile(process.env.BASELINE_BUNDLE, 'utf8'));
const extra = JSON.parse(await readFile(
  `${process.env.JEV_REPO}/fixtures/guardrail/train-counterfactuals.json`, 'utf8'));
assert.equal(baseline.records.length, 612);
assert.equal(extra.length, 48);
assert.ok(extra.every(row => row.split === 'train' && row.modelEligible === true));
const trainingInput = {...baseline, records: [...baseline.records, ...extra]};
await writeFile(process.env.TRAINING_INPUT_BUNDLE,
  JSON.stringify(trainingInput, null, 2) + '\n', {flag: 'wx', mode: 0o600});
JS
```

An independently exported bundle can have different provenance metadata or
serialization, so its physical hash need not equal the temporary bundle's
hash above. The exact authored mapping, split counts and original prepared-row
identities must still pass the stated gates. A disagreement requires rejecting
that preparation rather than changing targets, overwriting baseline evidence
or admitting a mismatched run. The recipe uses exclusive creation: choose a
fresh output path for a repeat.

Use the existing guardrail preparation command with the original reviewed
Google checkpoint, a new candidate directory and the same RFDT profile:

```sh
node "$JEV_REPO/scripts/guardrail-train.mjs" prepare \
  --bundle "$TRAINING_INPUT_BUNDLE" \
  --checkpoint /Users/bsonntag/code/simple-jev-ts/.build/hf-session-1_s2hbhu/home/hub/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752 \
  --steps 1536 \
  --run "$JEV_REPO/.build/guardrail/candidate-4"
```

This command is a reproduction recipe, not an execution receipt. Before
training, the run owner must verify the authored SHA, 300/144/0 branches,
original prepared TRAIN prefix, unchanged validation SHA, original checkpoint
file hashes, protocol and prospective source bindings. Preparation creates
the admission manifest before these additional checks. If any check fails,
move that new manifest aside to quarantine the run before training, retain
the other artifacts, and use a fresh directory for a repeat. The candidate 4
runner performs this quarantine automatically.
The existing CLI writes
the separate guardrail plan; it does not change the default general classifier.
Other settings remain seed 42, rank 16, scale 2, dropout zero, 26 q/v layers,
batch one, accumulation eight, learning rate 1e-4, default Adam and 2,048 full
tokens without truncation. The exclusion of Qwen and Chinese-lineage models,
derivatives, teachers and fallbacks continues to apply. Training, TRAIN post-fit
diagnosis, export, actual bridge validation, qualification freezing and held-out
inference remain distinct later gates. No qualification or promotion is
established by retaining this supplement.

The sealed source identities are augmentation SHA-256
`7ecbc47e9c8b1c1bb4f112c0978c62943197cda566ebb7be6a6a04b371c893a7`,
draft-manifest SHA-256
`e6ba8e48872b6dc4e5b6678cc698364a05dc362f3d7feda41b927ae9a5d5837e`,
and independent root-agent review SHA-256
`8c8cd67c483f5dfb6b6c15fb441a1470659a7843b47f024f9113e70aa5a8399d`.
The original qualification corpus SHA-256 remains
`f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2`.
