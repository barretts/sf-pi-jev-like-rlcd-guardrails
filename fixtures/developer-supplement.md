# Independently authored developer supervision supplement — revision 2

## Revision 2 provenance

Frozen on 2026-09-20T09:26:59.030Z. Root's source-only review reported that the original empty-range-expansion validation mechanism overlapped an existing protected exclusive-window repair task. Following that root instruction, this revision replaces only that semantic group and all four of its state/chat/order variants with a rectangular-matrix traversal dimension case. The explicit 2x3 input is [[11,12,13],[21,22,23]], the required 3x2 transpose is [[11,21],[12,22],[13,23]], and the observed output [[11,21],[12,22]] omits the third input column because the inner column loop uses grid.length (row count 2) instead of each row's length (column count 3). The iteration-boundary target, candidate descriptions, option orders, answer positions, and counts are unchanged. An unrelated image warning and unsupported timeout proposal remain distracting evidence. No protected repair or private TEST source was inspected.

TRAIN is byte-identical to the original freeze. Exactly four VALIDATION rows changed; the other 52 rows are byte-identical. The original proof under .build/improvement-experiments/supplement-preparation/ is preserved exactly at manifest SHA-256 `4a0e74acbba7711d0d5885b69e7c5bcd9f05cc32e65ddc2cf3e8ad6743e7bc87`. The new proof is under .build/improvement-experiments/supplement-preparation-r2/ and binds the original proof/output hashes, the root-driven reason, revised definitions, sources, transformations, measured letters, and CPU schema/logical validation.

Original output SHA-256 values: TRAIN `ddac462e2f9e62ae5875597a1710fb54498290fcfa1b185456d435f523d113d7`; VALIDATION `2e1ea3bb5316197f9f32edc22db2a59b038be74018283e726281eaa352d56f3b`; notes `52d71789bb8eace1c75920d57f1c7eeca95b734f6d475d00adeab5bd2b3b8de1`. Current corpus SHA-256 values: TRAIN `ddac462e2f9e62ae5875597a1710fb54498290fcfa1b185456d435f523d113d7`; revised diagnosis VALIDATION `b2f899fc1b92db198139ca6b16b8a2a44a55a219951bc627351bf93e521faae9`. At the revision 2 preparation handoff, root adoption was pending and no supplement model run had launched.

Prepared on 2026-09-20T09:16:32.815Z as an experimental input for conditional review. Preparation established valid fixtures and provenance; it supplied no training, model evaluation, reliability improvement, or speed/resource improvement evidence. No supplement training or inference was launched by the preparation task.

The new training file has **40 semantic groups / 160 choice-only rows**: 26 routing groups (two per each of 11 production Salesforce families, mixed, and general) and 14 diagnosis groups (two per each of seven production categories). Every class has exactly eight training rows. The independent diagnosis validation file has **14 groups / 56 choice-only rows**, two groups and eight rows per category. No final TEST file was created or modified. Existing validation/test scenarios and targets, including quality.jsonl and developer-workflows.jsonl, were not inspected during authored supplement preparation.

## Production boundary and authored evidence

Routing uses the exact instruction and option descriptions extracted from src/automation.ts. Inventories are the unchanged availableRouteFamilies helper's output for synthetic representative active-tool IDs that match its production rules. Prefix-matched tool suffixes are synthetic inventory identifiers; this does not establish actual deployed tool names or availability. Each active family has one independently authored operation under the full 11-family inventory and a different operation with that family plus two plausible distractors. The two mixed operations independently require Flow plus browser, and explicitly authorized synthetic Slack reading plus SOQL. The two general operations request unavailable Flow or Data360 capability and expressly exclude all available substitute work.

Diagnosis is built through buildDeveloperRecipeRequest, then filtered to its diagnosis choice question without changing the instruction or default descriptions. Its state retains the production user_task/evidence shape. All contexts are synthetic. Blocking diagnostics, relevant contracts/source/specifications, unrelated warnings, and unsupported proposed fixes are explicit. Validation mechanisms were authored independently from the category definitions and differ from TRAIN mechanisms; its cases and labels are frozen before any supplement training, candidate evaluation, or label inspection for selection. The concurrent root training job uses the preexisting frozen 570-row corpus and does not use these new cases.

## Frozen transformations

1. An authored operation/evidence context is one semantic group, assigned wholly to TRAIN or diagnosis VALIDATION. No context is reused across these splits.
2. Each group expands to two deterministic option orders and two representations per order, giving four rows. State contains the production-shaped context object. Chat contains one user message with the canonical JSON of that exact object. State and chat use byte-equivalent canonical evidence, identical targets, and identical option order for each order index.
3. Option permutations are whole-list rotations of the production candidate list. The target is moved to a predefined answer position; no candidate ID or description changes. Positions and inventories are frozen per group in the ignored proof. Different order variants preserve exactly the same candidate set.
4. All representation/permutation variants remain under the same stable group_id. No counterfactual or transformation is split across training and validation. Target values are production candidate IDs; letters below are measured from preparePrompt(v2), never guessed from the target text.

For full routing inventories, the 22 order instances allocate G-M three times each and F once. The 22 reduced-family order instances allocate A/B five times each and C/D/E four times each. Mixed instances allocate F/A and F/C; general instances allocate B/C and D/E. Each instance is repeated exactly once for state and once for chat. This achieves the smallest feasible routing histogram range: the seven G-M positions can receive at most 22 instances, forcing at least one count at most three, while 26 reduced/general instances are restricted to A-E, forcing at least one count at least six. The achieved instance counts range from three to six. Both seven-option diagnosis corpora are exactly balanced at four order instances/eight rows per letter.

| Corpus               |   A |   B |   C |   D |   E |   F |   G |   H |   I |   J |   K |   L |   M |
| -------------------- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| train                |  20 |  20 |  20 |  18 |  18 |  14 |  14 |   6 |   6 |   6 |   6 |   6 |   6 |
| routing_train        |  12 |  12 |  12 |  10 |  10 |   6 |   6 |   6 |   6 |   6 |   6 |   6 |   6 |
| diagnosis_train      |   8 |   8 |   8 |   8 |   8 |   8 |   8 |   0 |   0 |   0 |   0 |   0 |   0 |
| diagnosis_validation |   8 |   8 |   8 |   8 |   8 |   8 |   8 |   0 |   0 |   0 |   0 |   0 |   0 |

TRAIN representations: state 80 / chat 80; option order1 80 / order2 80. VALIDATION representations: state 28 / chat 28; option order1 28 / order2 28.

## Validation and frozen proof

The current proof is under .build/improvement-experiments/supplement-preparation-r2/ and ignored by the existing .build/ ignore rule. It contains authored definitions, frozen corpus copies, source snapshots, isolated public module projections, per-group inventories/positions/context hashes, per-row logical prompt hashes and measured letters, the preparation script, and the freeze manifest. The public schema validators and logical preparePrompt compiler passed for all 216 rows. Group/ID uniqueness, split integrity, four-variant grouping, identical paired evidence/options/targets, candidate-set preservation, exact counts, category/class balance, deterministic orders, and actual letter histograms passed. Only public schema/logical prompt code was transpiled to the ignored proof directory; no dist/native/worker/controller build or file edit occurred.

Zero model/inference/tokenizer/GPU/network/Git/auth/CI calls were made by this supplement preparation. This proves fixture validity and provenance only. It does not prove human-label accuracy on real developer failures, native tokenizer compatibility, model accuracy/calibration, generalization, latency, resource improvement, or release eligibility. The preparation task left root review and any adoption decision pending; this file itself launched no experiment.

The frozen 570-row TRAIN-only input was used only to inspect its first three rows for schema/style and to compute its unchanged whole-file hash: `26ccd13bad6b59c096d9d0ca774128e45ed929a16af1fbaca03ebef4aa8fb07b`. None of its scenarios was copied. It remains unchanged.

New corpus file hashes: TRAIN `ddac462e2f9e62ae5875597a1710fb54498290fcfa1b185456d435f523d113d7`; diagnosis VALIDATION `b2f899fc1b92db198139ca6b16b8a2a44a55a219951bc627351bf93e521faae9`. Whole-file byte hashes of the production/public sources and read guidance/context are:

| File              | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| src/automation.ts | `801815b6084cbcbc3280af68f64f32e99465fc7dd69831353958b22bdfc533e2` |
| src/recipes.ts    | `c2d6a1ac5df49485c02f5b0fe4852a87a838b65244a898b6732c2ff1d3752364` |
| src/core.ts       | `6c019fadb85344f0e1c7b42a1d5cb98bab9fb2d0c885fa137c939b558d2e2944` |
| src/evaluation.ts | `36a6d959b093498c5fa55bababd844c1deb7b6618a48302028f6c17c33470dcb` |
| README.md         | `f6b170de8598c39de8ad2a883538825e6d50c7b66b1c43c770bf9877ffb2e7ef` |
| package.json      | `a9ed3ee4e6f3009f7ccd151f77b82c80cc152095124f56556c6f41f875dd00b8` |
| .gitignore        | `15ad6f36ebe49bf46d92ab19fb3cb8b556bb438db420c78bc4369112ea2a3139` |

Ownership was released to root after freeze verification. The preparation proofs retain the exact bytes at that handoff; later documentation edits do not alter either frozen corpus.

Root subsequently reviewed all 54 authored contexts and their category evidence and mechanically checked ID, group, and canonical-context separation from the original corpora and between the new splits. The accepted inputs are frozen for an equal-update comparison of fresh 512-step control and supplemented models. The control uses the original 570 TRAIN rows; the candidate uses those rows plus these 160 TRAIN rows. Both evaluate these 56 diagnosis VALIDATION rows alongside the unchanged legacy and developer validation suites. The control launched at 2026-09-20T09:32:29Z; the supplemented run remains scheduled after its cleanup. Current outcomes and limitations are recorded in EXPERIMENTS.md. This experimental adoption does not approve a model for production or establish developer performance benefits.
