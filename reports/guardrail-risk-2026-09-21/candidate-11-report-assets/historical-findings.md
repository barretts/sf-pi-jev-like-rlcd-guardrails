# Historical research and harness findings

This archive preserves selected exact excerpts from earlier assistant final answers in the specified session. Each excerpt is historical and may be stale. It is not fresh verification of the source papers, repositories, gateway, local models, runtime, or current process state. Gateway success does not qualify a local candidate. No new research, inference, TEST inspection, corpus inspection, training, or remote action was performed for this extraction.

The source event hashes identify the original JSONL events. The provenance file records the extraction scope, omitted prompt-only matches, and proof limits.

## Gemini guardrail research critique

Recorded 2026-09-22T03:35:07.231Z; source line 7052; event SHA-256 `086c66e11e04cdbc2aff5581c901c761a0022ed049c048086f4faf0670db0454`.

> Gemini’s strongest input is to use **paired safe and risky requests with similar wording**, then inspect the model’s raw score gaps and compare decisions before and after export to the local runtime. That is useful diagnostic work. Candidate 4 already includes 48 paired training examples, and our candidate 3 comparison found four requests whose decision changed at the 0.99 cutoff between the saved adapter and native runtime. That difference deserves investigation, though it does not explain the six unsafe automatic allows, which appeared in both.

> I would **not adopt the report’s proposed Candidate 5 recipe wholesale**. It presents score saturation as the cause without establishing it, changes several training settings at once, and overstates what temperature scaling can fix. I checked that last point against candidate 3’s saved validation scores: at any positive temperature, at least **9** benign requests would still be interrupted, above the current engine’s **3**. A temperature high enough to remove all six unsafe allows would interrupt at least **69** benign requests. That calculation uses validation scores only; it is not a new model qualification.

> The report also gives Gemma 3 1B a 128K context where [Google specifies 32K](https://ai.google.dev/gemma/docs/core/model_card_3), and its cited support for “all-linear” LoRA superiority is an [unrelated paper](https://arxiv.org/abs/2506.03476). [LoRA+](https://arxiv.org/html/2402.12354v2) is a reasonable experiment, but its paper does not make one learning-rate ratio mandatory for this task.


## Gemini temperature-scaling diagnostic proof limit

Recorded 2026-09-22T03:39:00.640Z; source line 7270; event SHA-256 `4510a74cad7b0a90e0cc0853d50111a13e3781cea3d9a578fd114cb0df9e4931`.

> This is a validation-score calculation, not a new inference run or evidence about candidate 4.


## TianyuCodings/NanoJev review

Recorded 2026-09-22T03:53:42.078Z; source line 8116; event SHA-256 `12a287302bd505729596190359ea030255240c2063143a66f3c886bbd1c9ed77`.

> NanoJev has useful ideas for a **future experiment**, but its released model cannot be the guardrail candidate under your stated constraints. Its backbone is **Qwen3-0.6B**, which you excluded, and its published results measure decisions in Maze, Snake, and ViZDoom—not unsafe tool-call approvals, unnecessary confirmations, or our 500 ms risk-check target. Its quick-start path also uses a different Python/CUDA serving stack from the local Gemma and Metal integration we are qualifying.

> The most relevant idea is its **decision head**: it scores supplied choices in one forward pass without generating answer tokens. That could be tested on an allowed Gemma backbone as a separate guardrail experiment. It is not an automatic speed or safety gain over our current selected-logit approach; either version would need to pass the same frozen qualification corpus.

> NanoJev’s matched training variants and validation-before-test workflow are also useful references for designing that experiment. Its own contract review cautions that output probabilities are not thereby calibrated, which matters when deciding whether a tool call may run without approval.

> I would **not import its checkpoint or run its Qwen-based tests**.


## TianyuCodings/JevHarness review

Recorded 2026-09-22T03:55:08.131Z; source line 8309; event SHA-256 `1826ea372b5fe410c76bf1ee862801e171bb3df26d9c02cb6a2d941dac1ea655`.

> JevHarness is a better **development-method reference** for this project than NanoJev’s model is. It lets an LLM propose task-specific features, questions, and decision logic, then uses execution traces and a trusted evaluator to compare revisions. Its stated boundary—task adapter owns observations, legal actions, side effects, and scoring—fits our requirement that sf-guardrail retain enforcement and exact policy.

> I would use its approach only **before candidate selection**: study guardrail TRAIN failures, propose a revised input or decision strategy, compare proposals on validation, and freeze the chosen implementation before held-out testing. Letting an evolving harness change questions or criteria after a qualification receipt would invalidate that receipt.

> The repository makes a similar distinction itself: its reported Pokémon improvement, 3/12 to 9/12 wins, is on the **Eval set used for selection**, not an independent unseen-game result.

> It is not a ready replacement for our local risk engine. Its example uses hosted Jev calls, and its reported selected-harness full-decision p95 is **657 ms** in that Pokémon run; neither figure qualifies our local Gemma path or proves the required ≤500 ms guardrail check. Its individual-call p95 is 348 ms, but those are different requests and measurement conditions.


## llmgw harness evidence boundary

Recorded 2026-09-22T04:00:00.594Z; source line 8612; event SHA-256 `e63d789cd765b3a3e8a0c73d46c88869a3ae399080cd1ebc2f8a777c466c8b45`.

> I found no completed `llmgw` run in this guardrail project’s evidence. A gateway model could exercise the request fixtures, bridge, and comparison logic, but it would not prove that the **local Gemma model** scores those requests correctly, initializes on Metal, or meets the 500 ms warm latency gate.

> candidate 3 answered **144/144 eligible validation calls** through the real sf-pi bridge with no model-execution errors. That showed the bridge and evaluation harness could run end to end. It also showed the model was **not qualified**: six unsafe allows and 19 unnecessary interruptions. A later normal Pi-startup trial hit a Metal command-queue initialization failure, so that startup path still needs a passing native rerun.

> The earlier gateway result I recalled—over 90% on a shared judgment harness—belongs to the separate **System One** project. It validated that project’s harness, not this guardrail setup or its local model.


## llmgw adapter inspection result

Recorded 2026-09-22T04:00:42.928Z; source line 8672; event SHA-256 `9bd117cff8ffaff65adafee31200897fa7546a155c0150a9279e01ba7f4dc9f9`.

> I checked the installed `codex-llmgw` client. There is **no gateway adapter in the guardrail harness**, so running that client by itself would only prove gateway connectivity and an external model’s answer. It would not add proof of the sf-pi risk bridge, local logits, or Metal runtime.


## llmgw harness clarification

Recorded 2026-09-22T04:02:00.645Z; source line 8727; event SHA-256 `19224a9abb71d9195927a93a74a6cbb93b7a4d9a92df550ca7532b1f38f418df`.

> **We can prove important parts of the harness work.** I was too broad when I said `llmgw` could not prove it.

> The strongest proof is the **actual local-model validation run**, which sent all 144 eligible requests through the sf-pi risk bridge and Jev worker, received 144 answers, and produced a comparison report with no model-execution errors. Separate Pi SDK tests exercised the hook with stub tools, including blocking, confirmation, audit, fallback, and shadow mode without executing dangerous operations. Those results show the request and comparison path works; `llmgw` is not needed to establish that.

> What we **cannot claim yet** is that the *entire deployment path* is good: candidate 3 failed the safety and interruption gates, and a later normal-startup native trial failed during Metal initialization.

## Stop receipt limit

No matching tool result establishing canceled=true, signal=15, and steps=664 was found. No stop-state claim is made from this archive.
