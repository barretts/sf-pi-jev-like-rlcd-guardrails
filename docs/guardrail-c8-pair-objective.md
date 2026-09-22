# Candidate 8 paired-margin prototype

This is an optional **TRAIN-only** RFDT objective for the guardrail risk question. It does not change the general RFDT objective, Jev's native selected-next-token inference, sf-guardrail's enforcement hook, or the currently deployed decision cutoff. No Candidate 8 model or qualification score is produced by this prototype.

The caller supplies both `guardrailPairsPath` and `guardrailPlanPath` to `trainRfdt`. Without both, RFDT retains its existing selected-label cross-entropy training. With both, preparation must contain only TRAIN branches; calibration, VALID, and TEST groups must be held outside this fit run. The worker checks exact allow/confirm one-hot targets and reads only prepared TRAIN rows. It records the pair-manifest and objective-plan hashes in the adapter manifest.

The pair manifest has this shape (IDs refer to prepared `source_id` values):

```json
{
  "version": 1,
  "pairs": [
    {
      "pair_id": "c8-example-bash",
      "group_id": "c8-example",
      "safe_id": "c8-example-bash-allow",
      "risky_id": "c8-example-bash-confirm"
    }
  ]
}
```

Every pair must use two distinct, previously unused TRAIN sources in the same group, with opposite risk labels. Machine validation does not prove that the operations are a meaningful counterfactual pair; a reviewer must check that only the execution-relevant action or fact changes. The worker samples groups equally and cycles their paired and unpaired units. A group with more surface variants cannot dominate by row count alone.

The objective plan must be created and pinned **before fitting or scoring**. Its `pair_manifest_sha256` is the SHA-256 of the exact pair file bytes:

```json
{
  "version": 1,
  "purpose": "candidate8_train_only",
  "objective": "guardrail_train_group_pair_margin_v1",
  "pair_manifest_sha256": "<64 lowercase hex characters>",
  "loss": {
    "pair_margin": 2.0,
    "anchor_margin": 1.0,
    "ce_weight": 0.25,
    "anchor_weight": 0.5
  },
  "cutoff_status": "unset_requires_train_calibration_before_VALID",
  "validation_rows_passed_to_training": 0,
  "test_rows_passed_to_training": 0
}
```

For final-prompt logits, let `d(x) = z_allow(x) - z_confirm(x)`. A reviewed safe/risky pair `(s, r)` has loss

`softplus(2 + d(r) - d(s)) + 0.125[softplus(-d(s)) + softplus(d(r))] + 0.5[softplus(1 - d(s)) + softplus(1 + d(r))]`.

Unpaired TRAIN rows retain a binary cross-entropy term plus the matching absolute anchor. To avoid keeping two Gemma forward graphs alive together, the worker computes each row's `d` and `∇d` sequentially and combines them with the analytic scalar derivatives. The random tiny-Gemma CPU test checks the resulting loss and gradients against direct pair autograd, and checks a bounded memory envelope. It does not establish memory or effectiveness for the real 1B checkpoint.

**Decision protocol boundary:** the anchor margin of 1 corresponds to only about 0.73 selected-token `allow` probability. The current C7 runtime requires 0.99. This prototype is therefore not ready for C8 VALID scoring under the unchanged C7 protocol. A future candidate must either predeclare a higher safe-logit margin or derive a model-specific cutoff from reserved TRAIN calibration groups. That cutoff and its policy/model/protocol binding must be frozen before a fresh blind C8 VALID split is opened. C7 VALID scores must not be used to choose it. The C7 held-out TEST remains sealed.
