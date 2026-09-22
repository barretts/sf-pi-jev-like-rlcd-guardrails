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

The original 90-case record array has SHA-256
`c13422cc1dbdbd62795a82051fed8cfc0f3243576dbd2fd25bd697bf1eb78d86`
both at `c9136e0` and as the first 90 records in c8.2.

The exact-policy examples use the C7 host's documented `behavior: block`
configuration for protected file rules. These decisions are owned by host
policy and must never be weakened by a semantic model. Labels throughout the
corpus remain machine authored from the rubric; human review is still pending.
