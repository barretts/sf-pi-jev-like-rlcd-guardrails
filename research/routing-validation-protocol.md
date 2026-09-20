# Routing workflow synthetic validation protocol

This fixture is a fresh, independently authored machine synthetic validation set. It contains 60 cases: 20 easy, 20 hard, and 20 unknown. It is validation material, not human-authored data, a human-reviewed acceptance set, or a final unseen test. Its results may establish behavior on these frozen examples; they do not establish production accuracy or broad generalization.

The author did not inspect new routing source, training data, model predictions, model outputs, or evaluation results. Case construction uses the requested schema and explicit task contracts only. No model inference, training, benchmark, download, or external call was used to create or verify this fixture.

## Frozen inputs

The fixture is `fixtures/routing-validation.json`, with top-level shape `{"version":1,"cases":[...]}`. Each case has `id`, `family`, `label`, `prompt`, `essentialFactsAvailable`, and an exact `expected` JSON object. Some cases additionally include `previousExchange`, which is an explicit input to the workflow, not an answer or hidden fact.

Fixture SHA-256 at freeze: `fc91537d87cb7c0173e3fc06941336519fbab4c84fd3d8039d1111b836c8d3cf`.

Freeze this file and the workflow policy before the first inference. Record the fixture digest, workflow/source revision or digest, exact model identity and revision, prompt configuration, route mapping, and execution settings in evaluation outputs. Preserve the first complete predictions and failures. Do not amend cases, answers, route rules, or prompts after seeing their results and call the amended run an independent validation. Any subsequent use for debugging or tuning must be disclosed; a later final test needs a separate fresh set.

## Case families and labels

| Label | Families | Cases per family | Essential facts |
|---|---|---:|---|
| easy | `shallow_copy`, `basic_arithmetic`, `read_fields`, `simple_transform` | 5 each | Available |
| hard | `concurrency`, `security_policy`, `merge_semantics`, `transaction_consistency` | 5 each | Available |
| unknown | `missing_numeric_input`, `missing_prior_result`, `missing_options`, `missing_policy_or_context` | 5 each | Missing |

Easy cases cover practical reading, arithmetic, shallow-copy behavior, and bounded transformations. Hard cases require execution-order, access-policy, three-way-merge, or transaction reasoning under stated rules. Hard does not mean nondeterminate: all essential facts are included, and each case has one literal expected object. Unknown cases deliberately lack facts needed to produce the requested result. They require an explicit clarification object rather than an invented answer.

The fixture alternates five presentation forms: direct request, XML-style request envelope, a JSON-quoted request string, a JSON role/content envelope, and a delimiter envelope. The output instruction also appears before or after the task. Input field and option order vary in selected cases. Every exact `(prompt, previousExchange)` pair and every ID is unique. These are presentation variants within a synthetic set, not independent real-user samples.

## Workflow evaluation

For each frozen case, pass `prompt` and, when present, `previousExchange` through the complete workflow. Score both the route decision and the downstream response. Before running, document how the workflow's route names map to `easy`, `hard`, and `unknown`; do not infer or change that mapping from observed predictions. Keep router predictions separate from expected answers, and save raw downstream output before parsing.

A request is correct only when the downstream output is one JSON object equal to `expected`. Ignore object key order and insignificant JSON whitespace. Preserve array order and exact string values. Reject Markdown fences, explanatory text, duplicate object keys, extra keys, missing keys, nonfinite numbers, malformed JSON, and booleans substituted for numbers. JSON numbers may use equivalent finite representations, such as `70` and `70.0`, without changing their mathematical value. `null` is distinct from a missing field.

For unknown cases the exact contract is `{"action":"clarify","missing_facts":[...]}`, with essential input names sorted alphabetically. This object requests the missing facts. A guessed task answer fails even if a guessed number or choice happens to be plausible. `essentialFactsAvailable` and `expected` are evaluator metadata and must not be inserted into the router or solver request.

Report at least: the 3-by-3 routing confusion matrix; routing accuracy by label and family; strict downstream correctness by label and family; unknown clarification correctness; easy cases unnecessarily escalated; hard cases routed to the easy path; unknown cases routed without conservative handling; errors and timeouts; and end-to-end timing with the timing boundary stated. Any baseline comparison must use identical case inputs and output scoring. Route accuracy alone does not prove workflow correctness, and token accounting alone does not prove measured latency reduction.

Use the project's separately agreed acceptance gates. This protocol does not create a new acceptance threshold. Identify which gates were checked and report actual counts, including failures, rather than converting this validation set into a general production claim.

## Static author checks

Before freeze, verify version and case schema, 60 unique IDs and input pairs, 20 cases per label, five cases per family, and fact-availability flags. All 60 cases have literal expected objects. Independently check easy arithmetic: `4 * 18.75 - 5 = 70`, `36 + 18 - 11 = 43`, `945 / 7 = 135`, `0.15 * 80 = 12`, and `3 * 7 + 2 * 4 = 29`. The concurrency and stock arithmetic checks are `10 + 1 = 11`, `10 + 2 = 12`, and `3 - 2 - 2 = -1`, under their explicitly supplied execution rules. These are source/fixture checks; they are not model measurements.
