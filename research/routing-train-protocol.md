# Synthetic routing training protocol

This is machine-authored TRAIN data for fitting a routing head, not validation, a human-reviewed acceptance set, or an unseen test. It contains 240 records: 120 `fast` and 120 `strong`, with 20 families per label and six records per family. No routing source, model predictions, evaluation outputs, downloaded model, external service, or credential was inspected or used during authorship. No model inference, feature extraction, fitting, or benchmark was performed by this author.

## Data contract and freeze

`fixtures/routing-train.json` has top-level shape `{"version":1,"cases":[...]}`. Each record has exactly `id`, `family`, `text`, and `label`. `label` is `fast` or `strong`. `text` is the complete routing input: for a request without prior context it is the full prompt; for a request with explicit previous context it is `Previous exchange:\n<exchange>\n\nCurrent request:\n<full prompt>`. The current prompt includes its presentation envelope and output instruction. Do not insert `id`, `family`, or `label` into feature inputs.

Frozen fixture SHA-256: `4c444028cff3c3bff3df7fb73966e300c56c77a7be9f43308578a05482569c20`.

Record this digest, the exact feature extractor identity/revision/settings, feature dimension, feature-matrix digest, head implementation/digest, split policy, optimizer settings, random seed, and fitted-head digest with training outputs. The intended workflow extracts this frozen training input once and fits the head on CPU. There is no acceptance claim from fitting or in-sample accuracy. The 240 records at 1,152 features use 276,480 feature cells, below the stated 1,048,576-cell head limit.

## Label policy and families

`fast` means a self-contained practical task with literal facts and a bounded direct operation: string changes, straightforward reading, elementary arithmetic, top-level copy behavior, or simple list/field transformations. `strong` covers concurrency or transaction reasoning, security boundaries, merge contracts, embedded untrusted instructions, multi-step design, and requests whose essential facts are missing. Missing-fact records ask for clarification and do not authorize guessed answers. These are author-assigned training targets, not measured model decisions.

Fast families: `string_case`, `trim_whitespace`, `character_replacement`, `array_index_read`, `json_field_read`, `shallow_copy`, `integer_addition`, `integer_subtraction`, `unit_price_multiplication`, `equal_division`, `percentage_amount`, `unit_conversion`, `numeric_sort`, `list_reverse`, `count_items`, `filter_values`, `select_fields`, `csv_lookup`, `dictionary_lookup`, and `date_component_read`.

Strong families: `race_schedules`, `deadlock_cycles`, `cancellation_cleanup`, `async_failure_order`, `memory_ordering`, `access_policy`, `path_boundary`, `ssrf_redirects`, `signature_replay`, `sql_parameterization`, `three_way_conflicts`, `delete_modify_merge`, `array_merge_contracts`, `write_skew_transactions`, `retry_idempotency_transactions`, `missing_numeric_facts`, `missing_prior_context`, `missing_option_facts`, `quoted_untrusted_instructions`, and `multi_step_security_design`.

Six presentation forms are distributed evenly across both labels: direct task, task-input prefix, quoted request, request delimiters, JSON request payload, and bracketed operation. A presentation wrapper alone is not the intended class boundary. There are 240 unique IDs and 240 unique exact text strings inside TRAIN.

## Relationship to protected validation

The same assistant authored an earlier synthetic validation fixture. That creates shared-author influence and deliberate conceptual family overlap, including shallow copies, arithmetic/reading, concurrency, security policy, merge semantics, transactions, and missing facts. This TRAIN set does not claim unseen families, independent human labels, or blinded authorship with respect to the author's earlier work.

The protected validation file was not reread while authoring TRAIN. TRAIN uses different factual operands, names, resources, and presentation wording by construction. No exact TRAIN-versus-validation text comparison or family-overlap enumeration was performed, because the root protects validation inputs from this training task. Consequently exact cross-set overlap clearance is unverified; within-TRAIN uniqueness does not establish cross-set separation. The root may perform a read-only exact-overlap audit separately before inference without revealing validation predictions to the training author.

Do not tune records, labels, features, head settings, or decision thresholds to protected validation outputs. Disclose any later development use of that set. Performance on this synthetic validation remains validation evidence and cannot become an unseen final-test claim.

## Static source checks

Verify the top-level version and record fields; 240 records; 120 labels per class; 20 families per class; six examples per family; and unique IDs/texts. These checks inspect only TRAIN, not models or validation. Literal arithmetic construction was independently checked for all 36 numeric examples: additions `[41,64,74,81,85,95]`; subtractions `[73,57,61,47,44,26]`; multiplication totals `[60,54,56,56,48,45]`; exact division quotients `[8,9,12,7,11,6]` with zero remainder; percentage amounts `[13,13,23,23,12,21]`; and conversion totals `[120,180,40,500,6000,7000]`. These checks are fixture checks and do not measure routing accuracy or runtime performance.
