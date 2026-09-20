# Routing validation v2: source-blind authoring and freeze protocol

This is a machine-authored **validation** corpus. It is not human-reviewed and is not an unseen final test. Labels describe authored task requirements: `easy` cases contain finite closed arithmetic, literal JSON reads, literal ASCII string transforms, or finite array transforms; `hard` cases contain explicit finite security, concurrency, transaction, or merge rules requiring multi-step reasoning; `unknown` cases lack actual essential facts.

## Access boundary and provenance

The independent author received only the case-schema contract and the scope rules. The root agent had already trained the head before this corpus was created. The author did not inspect that head or its source, repository routing or training source, older fixtures/TRAIN/validation, predictions, results, rollouts, memory, credentials, or configuration. The only prior failure information supplied was an aggregate statement that a first harness rejected all cases before the encoder; it was not used to shape parser-specific tasks.

The author checked only the exact two target paths for absence and exact upchain `AGENTS.md` paths for applicable guidance; no such guidance file was present. No broad repository exploration occurred. No model, inference, network, GPU operation, process-control action, descendant agent, or commit was used. All answers depend only on explicitly supplied finite facts and rules. Quoted hostile strings remain data and cannot alter output contracts.

An initial CPU authoring run caught a generic-field-checker indexing error before either target was written. That checker was corrected before the successful complete audit and initial file creation. This was pre-freeze authoring work and involved no inference.

## Schema and independence

The JSON file is an object with `version: 1` and `cases`. Every case has `id`, `family`, `label`, `prompt`, `essentialFactsAvailable`, `expected`, and `metadata`; two authored cases also have `previousExchange` with string `user` and `assistant` fields. `expected` is a literal JSON object. Metadata is exactly `{"independent":true,"group":case_id}`. Identifiers begin with `v2_`.

There are **60 cases**, **60 distinct ids**, **60 distinct prompts**, and **60 unique groups**: **20 easy, 20 hard, 20 unknown**. There are 12 families, four per label, with five cases per family. The five cases in a family are different underlying tasks, not presentation variants of one task. Each family uses direct, XML request envelope, JSON quoted task, JSON role/content envelope, and delimited request presentation exactly once. Group ids therefore intentionally remain unique. Field names and supplied object key order vary; output object key order has no semantic meaning.

Every easy or hard case has `essentialFactsAvailable: true`. Every unknown case has `essentialFactsAvailable: false` and exactly `{"action":"clarify","missing_facts":[...]}` as its expected object, with nonempty names sorted alphabetically. Hypothetical prior exchanges do not provide unavailable actual facts.

## CPU gold audit

All **60 expected objects** were computed on CPU from authored finite facts and all **60** were cross-checked with a separate calculation or independently authored missing-name checklist before either file was written. No numeric answer was guessed. Checks compare whole objects, including array order, permission reasons, transaction outcomes, final versions, rollback state, conflict sets, and missing fact names. These are checks of authored gold data, not predictions or claims of model performance.

Primary and secondary calculations share supplied finite facts and explicit rules but use different calculations or representations. Their agreement establishes internal gold consistency; it does not establish human review. CPU checks also verified the schema, 20/20/20 split, five-per-family counts, 60 unique ids/groups/prompts, optional previous-exchange field types, and exact unknown-answer shape. JSON serialization was parsed back and compared to its original object.

| Family | Label | Cases checked | Primary / independent check |
| --- | --- | ---: | --- |
| `bounded_inventory_transactions` | `hard` | 5 | dictionary snapshots versus independent tuple stack and scalar ledger |
| `explicit_three_way_merge` | `hard` | 5 | sentinel selection versus presence-value change classification |
| `finite_array_transforms` | `easy` | 5 | list/filter/index calculations versus separate run-scan or pair calculations |
| `finite_order_arithmetic` | `easy` | 5 | products versus repeated-unit expansion; integer quotient versus divmod |
| `literal_json_reads` | `easy` | 5 | generic path walking versus direct literal indexing |
| `literal_string_transforms` | `easy` | 5 | separate literal/character calculations and character counts |
| `optimistic_concurrency` | `hard` | 5 | state maps versus independent version maps and append-only write journals |
| `scoped_security_policy` | `hard` | 5 | declarative failures versus reversed-precedence imperative decisions |
| `unavailable_arithmetic_inputs` | `unknown` | 5 | required-fact availability scan versus independent missing-name checklist |
| `unavailable_authorization_facts` | `unknown` | 5 | required-fact availability scan versus independent missing-name checklist |
| `unavailable_comparison_inputs` | `unknown` | 5 | required-fact availability scan versus independent missing-name checklist |
| `unavailable_transaction_state` | `unknown` | 5 | required-fact availability scan versus independent missing-name checklist |

## Freeze and evaluation use

Both target paths were absent before creation and were written by exclusive creation. The corpus bytes and this protocol were finalized before inference. The files are frozen at creation: no edits are allowed after inference or after the root requests freeze. A later correction requires a new version and separately disclosed evaluation; it must not silently revise this corpus.

Frozen UTC timestamp: **2026-09-20 17:42:10 UTC**.

Corpus file: `/Users/bsonntag/code/simple-jev-ts/fixtures/routing-validation-v2.json`.

Corpus byte count: **133720**.

Corpus SHA-256: `e60a1b49b2f73d104a8a9c6221b5fda335b326b5f1bfdbb49ef8328da8b3752d`.

Protocol file: `/Users/bsonntag/code/simple-jev-ts/research/routing-validation-v2-protocol.md`.

The protocol SHA-256 is reported separately after writing, rather than embedded self-referentially. Verify both reported digests before inference. Keep this validation corpus separate from training and head-selection inputs. Report route/classification results and task-output results separately and disclose trained-before-authoring order and machine-authored status. No inference result is recorded in either frozen file.

## Per-case CPU gold audit

These are the independently cross-checked gold objects. Key order is immaterial. This is a pre-inference authoring audit with no predictions.

| Case id | Presentation | CPU-computed expected object |
| --- | --- | --- |
| `v2_finite_order_arithmetic_01` | `direct` | `{"subtotal_cents":1825,"discounted_cents":1700,"tax_cents":119,"total_cents":1909,"balance_cents":1309}` |
| `v2_finite_order_arithmetic_02` | `xml_request` | `{"subtotal_cents":1598,"discounted_cents":1388,"tax_cents":111,"total_cents":1499,"balance_cents":999}` |
| `v2_finite_order_arithmetic_03` | `json_quoted_task` | `{"subtotal_cents":2784,"discounted_cents":2500,"tax_cents":125,"total_cents":2740,"balance_cents":1340}` |
| `v2_finite_order_arithmetic_04` | `json_role_content` | `{"subtotal_cents":1482,"discounted_cents":1402,"tax_cents":84,"total_cents":1661,"balance_cents":1411}` |
| `v2_finite_order_arithmetic_05` | `delimited_request` | `{"subtotal_cents":3906,"discounted_cents":3531,"tax_cents":317,"total_cents":3913,"balance_cents":1213}` |
| `v2_literal_json_reads_01` | `direct` | `{"warehouse_name":"Cedar","second_bin_units":13,"first_bin_code":"A4"}` |
| `v2_literal_json_reads_02` | `xml_request` | `{"owner_active":false,"first_status":"paused","second_id":"acct-s"}` |
| `v2_literal_json_reads_03` | `json_quoted_task` | `{"origin":"Birch","last_check_passed":false,"weight":17}` |
| `v2_literal_json_reads_04` | `json_role_content` | `{"selected_tag":"green","other_price":510,"selected_sku":"sku-9"}` |
| `v2_literal_json_reads_05` | `delimited_request` | `{"missing_metric":null,"third_serial":"R1","valid_count":22}` |
| `v2_literal_string_transforms_01` | `direct` | `{"transformed":"RED/BLUE/RED","character_count":12}` |
| `v2_literal_string_transforms_02` | `xml_request` | `{"transformed":"selur_roirp_lla_erongi","character_count":22}` |
| `v2_literal_string_transforms_03` | `json_quoted_task` | `{"transformed":"cat","character_count":3}` |
| `v2_literal_string_transforms_04` | `json_role_content` | `{"transformed":"!@CD","character_count":4}` |
| `v2_literal_string_transforms_05` | `delimited_request` | `{"transformed":"elm;pine;;oak","character_count":13}` |
| `v2_finite_array_transforms_01` | `direct` | `{"values":[18,8,14],"count":3}` |
| `v2_finite_array_transforms_02` | `xml_request` | `{"values":["fir","yew","oak","ash","elm"],"count":5}` |
| `v2_finite_array_transforms_03` | `json_quoted_task` | `{"values":[3,5,7,9],"count":4}` |
| `v2_finite_array_transforms_04` | `json_role_content` | `{"values":["Oren","Pax","Uma","Nia"],"count":4}` |
| `v2_finite_array_transforms_05` | `delimited_request` | `{"values":[7,5,6],"count":3}` |
| `v2_scoped_security_policy_01` | `direct` | `{"decisions":{"req-1-1":"allow","req-1-2":"deny:level","req-1-3":"allow","req-1-4":"allow","req-1-5":"deny:flag","req-1-6":"deny:flag","req-1-7":"deny:level","req-1-8":"deny:mfa"},"allowed_ids":["req-1-1","req-1-3","req-1-4"]}` |
| `v2_scoped_security_policy_02` | `xml_request` | `{"decisions":{"req-2-1":"deny:mfa","req-2-2":"allow","req-2-3":"deny:level","req-2-4":"allow","req-2-5":"allow","req-2-6":"allow","req-2-7":"allow","req-2-8":"deny:flag"},"allowed_ids":["req-2-2","req-2-4","req-2-5","req-2-6","req-2-7"]}` |
| `v2_scoped_security_policy_03` | `json_quoted_task` | `{"decisions":{"req-3-1":"allow","req-3-2":"allow","req-3-3":"allow","req-3-4":"allow","req-3-5":"deny:flag","req-3-6":"deny:flag","req-3-7":"deny:level","req-3-8":"deny:mfa"},"allowed_ids":["req-3-1","req-3-2","req-3-3","req-3-4"]}` |
| `v2_scoped_security_policy_04` | `json_role_content` | `{"decisions":{"req-4-1":"deny:mfa","req-4-2":"allow","req-4-3":"allow","req-4-4":"allow","req-4-5":"allow","req-4-6":"allow","req-4-7":"deny:level","req-4-8":"deny:flag"},"allowed_ids":["req-4-2","req-4-3","req-4-4","req-4-5","req-4-6"]}` |
| `v2_scoped_security_policy_05` | `delimited_request` | `{"decisions":{"req-5-1":"allow","req-5-2":"allow","req-5-3":"allow","req-5-4":"allow","req-5-5":"deny:flag","req-5-6":"deny:flag","req-5-7":"allow","req-5-8":"deny:mfa"},"allowed_ids":["req-5-1","req-5-2","req-5-3","req-5-4","req-5-7"]}` |
| `v2_optimistic_concurrency_01` | `direct` | `{"statuses":{"A":"aborted","B":"committed","C":"committed"},"cells":{"x":{"value":14,"version":2},"y":{"value":32,"version":5}},"reads":[{"event":2,"value":10},{"event":3,"value":30},{"event":5,"value":10},{"event":11,"value":30},{"event":13,"value":32}]}` |
| `v2_optimistic_concurrency_02` | `xml_request` | `{"statuses":{"D":"committed","E":"committed","F":"committed"},"cells":{"x":{"value":11,"version":4},"y":{"value":22,"version":4}},"reads":[{"event":2,"value":7},{"event":4,"value":11},{"event":6,"value":16},{"event":9,"value":19},{"event":13,"value":11}]}` |
| `v2_optimistic_concurrency_03` | `json_quoted_task` | `{"statuses":{"G":"aborted","H":"committed","I":"committed"},"cells":{"x":{"value":24,"version":7},"y":{"value":12,"version":6}},"reads":[{"event":2,"value":22},{"event":4,"value":22},{"event":7,"value":24},{"event":9,"value":27},{"event":12,"value":24},{"event":13,"value":9}]}` |
| `v2_optimistic_concurrency_04` | `json_role_content` | `{"statuses":{"J":"committed","K":"committed","L":"committed"},"cells":{"x":{"value":44,"version":4},"y":{"value":54,"version":10}},"reads":[{"event":2,"value":40},{"event":5,"value":50},{"event":10,"value":41},{"event":11,"value":53},{"event":14,"value":44}]}` |
| `v2_optimistic_concurrency_05` | `delimited_request` | `{"statuses":{"M":"aborted","N":"committed","O":"committed"},"cells":{"x":{"value":9,"version":10},"y":{"value":20,"version":2}},"reads":[{"event":2,"value":5},{"event":3,"value":18},{"event":5,"value":18},{"event":10,"value":5},{"event":13,"value":9}]}` |
| `v2_bounded_inventory_transactions_01` | `direct` | `{"live":{"cash":80,"units":7},"durable":{"cash":105,"units":5},"rejected_operations":[5,9],"open_savepoints":[]}` |
| `v2_bounded_inventory_transactions_02` | `xml_request` | `{"live":{"cash":70,"units":10},"durable":{"cash":70,"units":10},"rejected_operations":[5,10],"open_savepoints":["r"]}` |
| `v2_bounded_inventory_transactions_03` | `json_quoted_task` | `{"live":{"cash":72,"units":2},"durable":{"cash":65,"units":1},"rejected_operations":[3],"open_savepoints":[]}` |
| `v2_bounded_inventory_transactions_04` | `json_role_content` | `{"live":{"cash":90,"units":12},"durable":{"cash":105,"units":10},"rejected_operations":[4,11],"open_savepoints":[]}` |
| `v2_bounded_inventory_transactions_05` | `delimited_request` | `{"live":{"cash":79,"units":5},"durable":{"cash":79,"units":5},"rejected_operations":[7],"open_savepoints":[]}` |
| `v2_explicit_three_way_merge_01` | `direct` | `{"merged":{"count":4,"enabled":true,"extra":"L","limit":10,"owner":"C","quota":7,"tag":"new"},"conflicts":["count","extra","limit","mode","owner","quota"],"blocked":["mode"],"violations":["c1"]}` |
| `v2_explicit_three_way_merge_02` | `xml_request` | `{"merged":{"audit":true,"budget":120,"note":"v2","rank":2,"stage":"paused","team":"blue"},"conflicts":["budget","code","rank","slots","stage","team"],"blocked":["code","slots"],"violations":["k1"]}` |
| `v2_explicit_three_way_merge_03` | `json_quoted_task` | `{"merged":{"allocation":10,"ceiling":20,"stamp":"s1","status":"done","token":"b","verified":true,"weight":6},"conflicts":["allocation","ceiling","lead","status","token","weight"],"blocked":["lead"],"violations":["m2"]}` |
| `v2_explicit_three_way_merge_04` | `json_role_content` | `{"merged":{"agent":"L","cap":28,"label":"y","load":14,"new_field":"p","score":9,"secure":true},"conflicts":["agent","cap","load","new_field","phase","score"],"blocked":["phase"],"violations":["p1"]}` |
| `v2_explicit_three_way_merge_05` | `delimited_request` | `{"merged":{"checked":true,"keeper":"N","level":5,"mark":"b","max":45,"state":"stopped"},"conflicts":["addition","keeper","level","max","state","used"],"blocked":["addition","used"],"violations":["z2"]}` |
| `v2_unavailable_arithmetic_inputs_01` | `direct` | `{"action":"clarify","missing_facts":["unit_price_cents"]}` |
| `v2_unavailable_arithmetic_inputs_02` | `xml_request` | `{"action":"clarify","missing_facts":["shipped_units","starting_units"]}` |
| `v2_unavailable_arithmetic_inputs_03` | `json_quoted_task` | `{"action":"clarify","missing_facts":["hourly_rate_cents","withheld_cents"]}` |
| `v2_unavailable_arithmetic_inputs_04` | `json_role_content` | `{"action":"clarify","missing_facts":["end_minute"]}` |
| `v2_unavailable_arithmetic_inputs_05` | `delimited_request` | `{"action":"clarify","missing_facts":["round_one_points","round_two_points"]}` |
| `v2_unavailable_authorization_facts_01` | `direct` | `{"action":"clarify","missing_facts":["mfa_verified"]}` |
| `v2_unavailable_authorization_facts_02` | `xml_request` | `{"action":"clarify","missing_facts":["owner_id"]}` |
| `v2_unavailable_authorization_facts_03` | `json_quoted_task` | `{"action":"clarify","missing_facts":["actual_clearance"]}` |
| `v2_unavailable_authorization_facts_04` | `json_role_content` | `{"action":"clarify","missing_facts":["contract_active","role"]}` |
| `v2_unavailable_authorization_facts_05` | `delimited_request` | `{"action":"clarify","missing_facts":["denied_groups","subject_groups"]}` |
| `v2_unavailable_transaction_state_01` | `direct` | `{"action":"clarify","missing_facts":["initial_cash"]}` |
| `v2_unavailable_transaction_state_02` | `xml_request` | `{"action":"clarify","missing_facts":["initial_units"]}` |
| `v2_unavailable_transaction_state_03` | `json_quoted_task` | `{"action":"clarify","missing_facts":["current_version"]}` |
| `v2_unavailable_transaction_state_04` | `json_role_content` | `{"action":"clarify","missing_facts":["current_value","current_version"]}` |
| `v2_unavailable_transaction_state_05` | `delimited_request` | `{"action":"clarify","missing_facts":["balance_before","debit_cents"]}` |
| `v2_unavailable_comparison_inputs_01` | `direct` | `{"action":"clarify","missing_facts":["left_map"]}` |
| `v2_unavailable_comparison_inputs_02` | `xml_request` | `{"action":"clarify","missing_facts":["base_map","right_map"]}` |
| `v2_unavailable_comparison_inputs_03` | `json_quoted_task` | `{"action":"clarify","missing_facts":["before_values"]}` |
| `v2_unavailable_comparison_inputs_04` | `json_role_content` | `{"action":"clarify","missing_facts":["new_record"]}` |
| `v2_unavailable_comparison_inputs_05` | `delimited_request` | `{"action":"clarify","missing_facts":["left_limit","right_limit"]}` |
