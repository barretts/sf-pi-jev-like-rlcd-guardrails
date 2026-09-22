# Candidate 8 VALID harness preflight

This bundle contains model-free evidence for the corrected, **VALID-only** C8
corpus. It is not a C8 model effectiveness score or a qualification receipt.
No held-out cases or external tool operations were read or executed.

- `fake-shadow-report.json` is the complete 96-case sf-pi shadow replay with a
  deliberately always-confirm fake provider. The current rule engine matched
  83/96 authored labels, with 11 unsafe automatic allows and two benign
  interruptions. The fake provider answered all 58 prepared calls; six cases
  explicitly fell back before a model call, no attempted call fell back, and
  all three exact blocks stayed in code. Its 57/96 match rate and warm times
  are properties of the fake provider and cannot support a model claim.
- `native-compile-only.json` uses the retained C7 Gemma GGUF as a
  tokenizer/chat-template reference. The native backend only compiled the 58
  model-bound C8 prompts; it did not evaluate logits. All 58 compiled. Zero
  exceeded 2,048 prompt tokens or 32 KiB of model input; maximum observed was
  1,542 prompt tokens and 7,084 input bytes. This does not establish that a C8
  candidate will meet the 750 ms warm-risk deadline.

The input and runtime pins are:

| Item | SHA-256 or commit |
| --- | --- |
| C8 VALID bytes | `a95f61b055d4e214d1e0245b1b87f417a06ddbd1fb10a6f1c3e003ea2d1dbad8` |
| Independent model-free preflight | `d7f021ad051b3c4842dd8ae219ba08f3e17796e23a42803fc8bf4544e0c3571c` |
| sf-pi host commit | `bc7862b078997d2c60aa908979b5cbf59f83db80` |
| sf-pi risk runtime | `6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e` |
| Jev scoring protocol | `d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530` |
| C7 Gemma reference GGUF | `9d1bffc4ed982dea529841d20ac4a56cd0f5086107f2aa6da0c1ea17ae148006` |
| Native compiler | `7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96` |

`SHA256SUMS` binds the two raw JSON receipts. The source-pinned scripts are
`scripts/guardrail-candidate8-valid-eval.mjs`,
`scripts/guardrail-candidate8-host-core.mjs`, and
`scripts/guardrail-candidate8-valid-compile-preflight.mjs`. The fake report
records evaluator Git HEAD `7d0a451` and was regenerated after the compile
callback was added. The native compile receipt was also produced from that
HEAD. Native CPU context initialization failed inside the filesystem sandbox;
the identical compile-only invocation succeeded with native runtime access.

The labels remain machine-authored with human review pending. A changed
decision cutoff, model protocol, or sf-pi runtime requires a new model-free
preflight and a separately committed seal before real C8 VALID scoring.
