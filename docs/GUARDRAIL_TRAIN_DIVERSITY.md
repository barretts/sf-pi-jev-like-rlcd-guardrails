This prospective supplement retains **80 TRAIN inputs in 40 groups**, with 40 allow and 40 confirm targets. Labels were machine authored from the explicit operation-policy rubric and source reviewed by agents; human label review is pending. It is available for a future TRAIN-only data experiment. Retention does not select another candidate or start preparation, training, export or model calls.

`fixtures/guardrail/train-diversity-inputs.json` is an array of exactly seven-field rows: `id`, `groupId`, `family`, `split`, `expected`, `modelEligible`, `riskInput`. Each `riskInput` contains only the complete original tool request and typed facts independently resolved by the unchanged SF bridge from authored mock observations. Baseline classifications, reasons and policy floors are excluded. The existing `scripts/guardrail-train.mjs` maps these row fields after they are appended to a separately approved bundle; an 80-row TRAIN-only supplement alone does not satisfy that command's validation requirement. This document runs only the existing baseline exporter.

`fixtures/guardrail/train-diversity-source.json` retains the 80 raw cases and observations for replay. Five unresolved org observations use the supported type `unknown`, without unsupported observation `guessed` metadata. The actual mocked resolver produced production with `guessed:true` for all five. All 80 requests match their exported bridge inputs, all are eligible and none has an exact-policy floor. Complete inputs match the CPU draft on 61 cases; 12 ordinary shell inputs gain source-resolved org facts and seven browser inputs gain mock snapshot digests.

The 80 cases have four unsafe baseline allows and six benign baseline interruptions against independent gold. These finite authored comparisons establish neither local-model quality nor improvement. Original qualification remains the unchanged **612-case corpus** with SHA-256 `f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2`; the preserved original baseline is `9f0c6e72ee091d971c84732b218d56f54eacd9956e37e3beb4f90d904bbf6645`. The mechanical 692-case merge below exists only to satisfy the existing source-export harness's coverage requirements. It must never be supplied as a qualification corpus or held-out evidence.

`docs/GUARDRAIL_TRAIN_DIVERSITY_PROOF.json` retains the actual source result, source reviews and full provenance exceptions. Earlier generator-reader contributions were discarded and replaced with fresh authors. Universal team non-exposure is false. Mock observations prove no live org/browser state, permissions, resource existence, vendor pane dispatch, nested server acceptance, secret contents or successful external operations. SOQL export/history depend on session prerequisites outside the supported facts schema; those prerequisites remain review prose and are never fabricated as typed host facts.

For source replay, use the matching Jev and SF checkouts and a preserved copy of the original baseline. The original corpus remains at `fixtures/guardrail/corpus.json`. The current worktree preserves its original baseline at `.build/guardrail/baseline.json`; preserve that file separately when moving checkouts. These files add no qualification cases. Set the three paths below to your local checkouts and preserved baseline. Existing SF test dependencies must already be installed. Each replay creates a fresh directory. The merge and projected-input writes use exclusive creation; the existing baseline exporter uses an ordinary write to a new output path whose absence is checked immediately beforehand. The replay does not edit a checkout and stops on a failed step.

```sh
(
set -eu
export JEV_PROJECT_DIR=/path/to/simple-jev-ts
export SF_PI_PROJECT_DIR=/path/to/sf-pi
export GUARDRAIL_REFERENCE_BASELINE=/path/to/preserved-original-baseline.json
export GUARDRAIL_REPLAY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jev-diversity-replay.XXXXXXXX")"

node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=process.env.JEV_PROJECT_DIR, out=process.env.GUARDRAIL_REPLAY_DIR;
const corpusBytes=await readFile(resolve(root,'fixtures/guardrail/corpus.json'));
const baselineBytes=await readFile(process.env.GUARDRAIL_REFERENCE_BASELINE);
assert.equal(sha(corpusBytes),'f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2');
assert.equal(sha(baselineBytes),'9f0c6e72ee091d971c84732b218d56f54eacd9956e37e3beb4f90d904bbf6645');
const sourceBytes=await readFile(resolve(root,'fixtures/guardrail/train-diversity-source.json'));
assert.equal(sha(sourceBytes),'1131bd1818e239fa8fac2c187ca5305c91bafe6eb4e9065b0fe6df8d717f9cdc');
const corpus=JSON.parse(corpusBytes), source=JSON.parse(sourceBytes);
assert.equal(corpus.cases.length,612);assert.equal(source.cases.length,80);
assert.ok(source.cases.every(row=>row.split==='train'));
// Original headers/cases are mechanically preserved. No reserved gold is used.
await writeFile(resolve(out,'merged-source-corpus.json'),JSON.stringify({...corpus,cases:[...corpus.cases,...source.cases]},null,2)+'\n',{flag:'wx',mode:0o600});
JS

(
  cd "$SF_PI_PROJECT_DIR"
  if [ -e "$GUARDRAIL_REPLAY_DIR/source-baseline.json" ]; then
    exit 1
  fi
  env -u NO_COLOR \
    -u GUARDRAIL_EVALUATION_OUTPUT -u GUARDRAIL_JEV_ROOT \
    -u GUARDRAIL_EVALUATION_SPLIT -u GUARDRAIL_CANDIDATE_FREEZE \
    -u JEV_GUARDRAIL_QUALIFICATION -u JEV_GUARDRAIL_MODEL_FILE \
    -u JEV_GUARDRAIL_MODEL_ID -u JEV_GUARDRAIL_ARTIFACT_REGISTRY \
    -u JEV_GUARDRAIL_MODE -u GUARDRAIL_SDK_LOCAL_MODEL \
    GUARDRAIL_CORPUS_PATH="$GUARDRAIL_REPLAY_DIR/merged-source-corpus.json" \
    GUARDRAIL_BASELINE_OUTPUT="$GUARDRAIL_REPLAY_DIR/source-baseline.json" \
    PI_CODING_AGENT_DIR="$GUARDRAIL_REPLAY_DIR/pi-agent" \
    SF_DISABLE_LOG_FILE=true \
    ./node_modules/.bin/vitest run extensions/sf-guardrail/tests/guardrail-corpus.test.ts
)

node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const load=async path=>JSON.parse(await readFile(path,'utf8'));
const root=process.env.JEV_PROJECT_DIR, out=process.env.GUARDRAIL_REPLAY_DIR;
const baseline=await load(resolve(out,'source-baseline.json'));
const original=await load(process.env.GUARDRAIL_REFERENCE_BASELINE);
assert.equal(baseline.records.length,692);assert.equal(original.records.length,612);
assert.equal(baseline.baselineSourceSha256,original.baselineSourceSha256);
assert.equal(baseline.provenanceSourceSha256,original.provenanceSourceSha256);
assert.deepEqual(baseline.records.slice(0,612),original.records);
const raw=(await load(resolve(root,'fixtures/guardrail/train-diversity-source.json'))).cases;
const rows=baseline.records.slice(612);
assert.equal(rows.length,80);
assert.ok(rows.every(row=>row.split==='train'&&row.modelEligible&&!row.policyFloor));
const corrected=['birch-orbit-a','birch-orbit-b','hazel-bridge-a','hazel-bridge-b','local-salesforce-01-b'];
for(const suffix of corrected){
  const row=rows.find(row=>row.id===`train-diversity-${suffix}`);
  assert.ok(row?.riskInput.facts.orgs?.length);
  assert.ok(row.riskInput.facts.orgs.every(org=>org.type==='production'&&org.guessed===true));
}
for(let i=0;i<80;i++){
  assert.equal(rows[i].id,raw[i].id);assert.equal(rows[i].expected,raw[i].expected);
  assert.equal(rows[i].riskInput.toolName,raw[i].toolName);
  assert.deepEqual(rows[i].riskInput.input,raw[i].input);
}
const projected=rows.map(row=>({id:row.id,groupId:row.groupId,family:row.family,split:'train',expected:row.expected,modelEligible:row.modelEligible,riskInput:row.riskInput}));
assert.deepEqual(projected,await load(resolve(root,'fixtures/guardrail/train-diversity-inputs.json')));
assert.equal(rows.filter(row=>row.expected!=='allow'&&row.baseline==='allow').length,4);
assert.equal(rows.filter(row=>row.expected==='allow'&&row.baseline!=='allow').length,6);
await writeFile(resolve(out,'replayed-train-inputs.json'),JSON.stringify(projected,null,2)+'\n',{flag:'wx',mode:0o600});
JS
printf '%s\n' "$GUARDRAIL_REPLAY_DIR"
)
```

The exporter exercises the safety kernel, request builder and policy floor with mocks. Its model-evaluation branch stays inactive because `GUARDRAIL_EVALUATION_OUTPUT` is unset. This replay performs no model preparation, training, export or authored tool execution. If the original prefix, eligibility, intended unresolved facts or projected inputs differ, keep the new directory as diagnostic evidence and stop before any training admission. Do not overwrite the retained supplement or change qualification criteria to accommodate a replay difference.
