# Candidate 8 source history

- **c8.1, VALID-only commit `c9136e0`**: 90 independently authored cases in
  45 contrast groups, 10 cases in each of the nine semantic lanes. The
  fake/stubbed C7 host preflight prepared 58 cases for model input, including
  21 expected approval cases. It found 26 host policy floors, six deliberate
  pre-model fallbacks, and no preparation error. This commit contains no TEST.
- **c8.2, additive exact-policy correction**: Three more VALID groups and
  three held-out TEST groups add six cases per split. Each new group pairs an
  allowed path or carve-out with a configured hard block. The original 90
  VALID case records and IDs are unchanged. This correction precedes any
  Candidate 8 model call or score. It supersedes c8.1 for C8 qualification;
  the earlier commit remains an immutable provenance point. The new VALID
  receipt pins the corrected source, host identity, per-case baseline action,
  routing lane, and risk-input digest. TEST remains sealed until model and
  scoring gates are frozen.
- **C7 final-host repin, VALID-only follow-up**: The fake/stubbed VALID replay
  was repeated on sf-pi commit `bc7862b078997d2c60aa908979b5cbf59f83db80`
  with host baseline SHA-256
  `6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e`.
  All 96 per-case baseline actions, routing lanes, and prepared risk-input
  hashes match the prior replay on `a12f1de85c1919fa2ff94bf9315c522b0ad382da`.
  No model was called. The newer receipt supersedes the older host receipt for
  Candidate 8 scoring.
- **C8 v2 protocol and shadow-host repin, VALID-only follow-up**: The same 96
  VALID cases were replayed without model calls or external operations against
  sf-pi commit `d86cdcfcfa02e419a4255291d16e56c48a5f2ade` and Jev runtime
  commit `c8d276d9a4157c7d825a0960b3e886a6d508c499`. The host baseline
  SHA-256 is `927c25ebee99f59ea349bcd6d5da06c9a999255e4e99d7658ee0f113da96e4f2`.
  Jev's C8 base decision protocol SHA-256 is
  `f4f00541c9ce815ca17d19400488f5e4e999c87e9712b7c0ec17419068e85f9b`;
  the scorer prompt SHA-256 remains
  `d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530`.
  The receipt's legacy `model_protocol_sha256` field is the scorer prompt SHA;
  the final model-specific scoring protocol will be selected from TRAIN
  calibration and is not used in this preflight. Every per-case baseline action,
  routing lane, and prepared risk-input hash matches the preceding C7 final-host
  receipt. The new receipt supersedes it for C8 VALID evaluation.
- **c8.3, pre-score browser correction and enforce-host repin**: Before any
  real C8 VALID score, independently re-reviewed case 085. Its original
  `Filter` button had only a label and page snapshot; those facts did not
  establish that clicking it was read-only. The safe side of the group is now
  a fresh observed `Contacts` navigation link on a Contact detail page with an
  ordinary list-inspection reason. The Delete side retains its requested
  operation and approval label; its group and template IDs change with the
  corrected group name. Only VALID records 085 and 086 differ from c8.2;
  case IDs, total count, and decision counts remain unchanged. The fake/stubbed
  replay uses the preimplemented fail-closed sf-pi host commit
  `bdbf6292f383a8b2e12cd236aafb2be9c335f463` (host baseline SHA-256
  `1e5e8167f25ce8fb440d7bf8054be44a27d67c0fa71272a5558b01204c24bd0e`)
  and a clean build of Jev
  commit `b65f981696316856a9dc67244be76f679b00a575`, with no model call or
  external operation. It records an original-operation SHA-256 for every row,
  including rows outside the model lane. Compared with the prior receipt, only
  case 085 changes baseline action/routing/prepared-input hash: it is now
  baseline allow and model prepared. This repin is source evidence, not a
  qualification result or a declaration that host review is complete.

The original 90-case record array has SHA-256
`c13422cc1dbdbd62795a82051fed8cfc0f3243576dbd2fd25bd697bf1eb78d86`
both at `c9136e0` and as the first 90 records in c8.2. The c8.3 correction
changes that historical first-90 checksum.

The exact-policy examples use the C7 host's documented `behavior: block`
configuration for protected file rules. These decisions are owned by host
policy and must never be weakened by a semantic model. Labels throughout the
corpus remain machine authored from the rubric; human review is still pending.
