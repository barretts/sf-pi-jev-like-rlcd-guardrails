**Developer harness successor proposal — not implemented or model evaluated**

This proposes one small deterministic tool that lets the assistant count literal lines, compare UTC timestamps, and perform exact integer arithmetic. The assistant still chooses whether to call it and which inputs to supply. The same tool is available in the raw and compact arms. It does not receive the question, expected answer, case ID, family, labels, or a scenario-specific interpretation rule.

This document is the only new artifact from the bounded followup. The running campaign's source pin remains `5a2aaf1af575a39002355e058720059ce25eb45a6e21ed99d820589020f9b058`. No tracked source, research, distribution, Git state, frozen result, fixture, or running protocol was changed. No actual answers, SF system messages, provider payloads, credentials, private configuration, model, network, GPU, or process were accessed for this proposal.

The motivation is ROOT's preliminary diagnostic, not an independent regrade: the timestamp case reportedly failed factual checks in three of four repetitions in each arm; a diff question reportedly admits a key-versus-assignment ambiguity and includes a malformed hunk; and the repeated-row case reportedly had seven nonaccepted workflows out of eight, including one compact completion that reached its 4,096-token length limit. ROOT reported no global HTTP 429, extension, or cleanup failures in that diagnostic. These are observations from an ongoing campaign; the final preserved ledger must establish final counts. This proposal does not reinterpret those failures or claim the current test passed.

Those observations suggest a bounded calculation capability could help both arms. A UTC comparator can calculate from the timestamps the model selects, but cannot select the correct event for it. A line counter can count the model's exact needle, but cannot decide which row type the question means. Neither operation resolves an ambiguous diff question. The existing V2 validation has been consumed and must never become a fresh successor holdout.

**Why this is a legitimate developer tool**

An ordinary coding assistant can use Bash, a short program, or an existing utility to calculate counts and time differences. The controlled evaluator deliberately grants only a bounded read tool, so its assistant must currently do those calculations in model inference. A bounded deterministic helper restores part of that ordinary capability without granting arbitrary command execution. Its benefit would be a harness and tool capability benefit, not a trained-model improvement.

The boundary against an answer oracle is concrete:

- The implementation accepts only a literal authorized file and explicit model arguments. It never imports the fixture's expected object, parses the question, reads case metadata, consults a scenario table, or recognizes named fixture families.
- It returns a count or a mathematical relation, not a task-specific answer object. The model remains responsible for choosing an event, needle, operands, answer keys, units, and final JSON.
- Its algorithms are fixed before fresh cases are authored. Fresh source-blind cases include distractors and require correct argument selection, so a wrong but syntactically valid selector yields the correct calculation for the wrong facts and still fails task acceptance.
- No postgrade answer normalization, corrected answer injection, hidden retry, or expected-answer-derived tool result is permitted.

A count computed over the original authorized file can bypass the need for the model to count repeats in encoded text. That is useful tool use, but it can mask model difficulties reading the compact representation. Consequently, helper-arm answer quality alone cannot establish compact-text interpretation fidelity. The study below preserves a separate read-only comparison.

**Smallest useful interface**

Add one tool named `trace_compute` beside the existing `read`. Keep its schema flat for the installed OpenAI-compatible SDK; enforce the operation-specific required and permitted field sets in host code as well as JSON schema validation. The proposed schema is:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "enum": ["trace.txt"] },
    "op": { "type": "string", "enum": ["count_lines", "compare_utc", "arithmetic"] },
    "mode": { "type": "string", "enum": ["exact", "prefix"] },
    "text": { "type": "string", "maxLength": 256 },
    "left": { "type": "string", "maxLength": 24 },
    "right": { "type": "string", "maxLength": 24 },
    "operator": { "type": "string", "enum": ["add", "subtract", "multiply", "divide"] }
  },
  "required": ["path", "op"],
  "additionalProperties": false
}
```

The tool description states: "Compute from trace.txt or explicit literal operands. Read trace.txt first. Count exact lines or line prefixes, compare strict UTC timestamps, or calculate exact integer arithmetic. Select the relevant facts yourself. This tool does not interpret the task."

Host validation permits exactly these shapes, with no coercion or extra fields:

| Operation | Exact required keys | Successful result |
| --- | --- | --- |
| `count_lines` | `path, op, mode, text` | `{ "count": 3 }` |
| `compare_utc` | `path, op, left, right` | `{ "relation": "earlier", "leftMinusRightMs": -86400000 }` |
| `arithmetic` | `path, op, operator, left, right` | `{ "numerator": "3", "denominator": "2" }` |

The displayed results are invented examples, not actual fixture facts. The tool response is a small strict JSON object containing `ok`, `op`, the supplied operation inputs, and `result`, or `ok: false` plus a fixed `errorCode`. The journal, rather than the model-facing result, retains the implementation SHA, exact arguments, source SHA and byte count, elapsed CPU time, and the result SHA. This avoids adding implementation details to the assistant's task unnecessarily.

`path` is always the same literal `trace.txt`, including for arithmetic and comparison, so the call is bound to the current authorized read context. Arithmetic and comparison operate only on the supplied operands: the host does not search for an event, silently substitute file values, or invent provenance for an operand absent from the file. The journal distinguishes supplied operands from file-derived counts. The model must select and quote the source facts.

**Deterministic behavior and limits**

- Capture the exact authorized trace during the already successful `read("trace.txt")`, and let the helper use that immutable snapshot. It must match the frozen original hash. Do not resolve a model-controlled path, follow a symlink, search the repository, read another session's file, or open any other file. The helper rejects calls before the successful read. The snapshot limit is 256 KiB of UTF-8 text and 20,000 physical lines, declared before authoring fresh cases.
- Count physical lines split at LF. Remove one preceding CR only when it belongs to a CRLF terminator. Preserve an unterminated trailing CR as literal content. A final LF creates no phantom extra line; an empty file has zero lines; `"\n"` has one empty line. Match with literal equality or `startsWith`, with a needle of at most 256 UTF-8 bytes and no LF or NUL. Empty needles are allowed and have their ordinary exact/prefix meanings. There are no user regular expressions, glob patterns, recursive matching, or semantic row classification.
- UTC operands must be exactly `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss.sssZ`, in years 1970 through 2100. Parse fixed fields, validate calendar/time ranges by a UTC field round trip, and reject overflow dates, non-Z offsets, leap seconds, omitted fields, and arbitrary Date.parse formats. Return the relation and signed left-minus-right milliseconds. This range stays within safe integer milliseconds. Date/time input outside the declared grammar is unknown, not guessed.
- Arithmetic operands are canonical signed integer strings containing at most 16 digits, with no leading zero, `+`, exponent, decimal point, whitespace, or `-0`. Parse with BigInt. Support exactly two operands and the four listed operators. Return an exact reduced rational as canonical numerator/positive-denominator strings; divide-by-zero is an error. This avoids floating-point rounding, unsafe JSON integer arithmetic, a general expression evaluator, and arbitrary code execution.
- Per session, allow at most four helper calls, eight total tool calls, and eight physical task-provider requests. Exceeding a limit is recorded and prevents unresolved workflows from qualifying. Keep Grok's existing fixed 4,096 generated-token bound and omitted temperature. These are execution bounds, not a user budget.
- Use fixed error codes such as `not_read_yet`, `invalid_arguments`, `path_not_allowed`, `input_limit`, `invalid_timestamp`, `invalid_integer`, `division_by_zero`, `frozen_source_changed`, and `call_limit`. Never include raw exceptions, directory paths, contents of forbidden files, or provider/auth details in an error.

The primitive parser must be actual CPU code with public-source tests, not a deterministic assistant/tool-call simulator or a function that reads expected outputs. Before live execution, test the installed SDK's real tool schema dispatch with fake transport under a global network deny guard. Include wrong needles, absent prefixes, mixed LF/CRLF, unterminated lines, empty files, repeated blocks with unique distractors, invalid and equal UTC values, UTC rollover, large integer multiplication, exact division, wrong paths, extra fields, call limits, source mutation, and recovered tool-argument mistakes. No real model is needed for that implementation verification.

Sixteen invented in-memory CPU calculations were executed during this design followup, without files, processes, network, model, or credentials. They covered exact and prefix repeated-line counts; no phantom trailing line; CRLF termination and literal trailing CR; empty lines and files; a valid leap-day difference of 86,400,000 ms; a 125 ms difference; rejection of an invalid leap day, month, leap second, and non-Z offset; exact 16-digit multiplication; exact 3/2 division; and divide-by-zero rejection. All sixteen passed. These calculations support the primitive definitions only. They do not verify a tracked parser, installed tool integration, autonomous tool selection, answer quality, speed, or performance.

**Successor evaluation before any predictions**

Use a new protocol, source snapshot, output directory, and fresh source-blind fixtures. Preserve the current campaign and all its negative results. The fixture author must not inspect the helper source, old predictions, or codec outputs while authoring. An independent CPU verifier can establish the fresh literal facts and exact gold objects before inference. Reject ambiguous or malformed questions before that freeze; do not repair their semantics after seeing answers. The old diff ambiguity remains an old negative result.

For causal separation, use a small 2-by-2 study on those same fresh cases:

| Arm | Context | Available task tools |
| --- | --- | --- |
| A | raw | `read` |
| B | compact | `read` |
| C | raw | `read`, `trace_compute` |
| D | compact | `read`, `trace_compute` |

A versus B measures compression with the existing read-only capability. C versus D measures compression with the successor tool capability held fixed. A versus C and B versus D measure the helper contribution at a fixed context representation. Comparing the old consumed corpus to a fresh helper corpus cannot isolate that contribution.

Keep the same selected llmgw xAI Grok model in all task and judge arms, the same released compression hook, the same 23 frozen SF factories, exact-origin bounded official SDK transport, strict final-answer parser, session shutdown/abort/dispose contract, and full physical ledger. The model autonomously selects actual tools; the initial user instruction requires reading the authorized file first, and the helper enforces that authorization prerequisite. Record all choices and argument errors. Do not fabricate the read call or force a helper invocation.

Predeclare 24 fresh cases and four repetitions if retaining the current study size. That produces 384 scheduled sessions. Use four concurrent case/repetition groups, with the four arms of each group sequentially sharing one opaque workspace path and separate session/agent directories. Use these fixed Williams orders across the four repetitions, rotating the starting row by a frozen case index:

```text
A B D C
B C A D
C D B A
D A C B
```

Each arm occupies each position once, and each ordered predecessor/successor pair occurs once. Raw-versus-compact order and read-only-versus-helper order are counterbalanced. Session cleanup must complete between arms; retaining a failed or unresolved shutdown prevents joint qualification. Use opaque group directory names so the effective SDK working-directory instruction does not expose a semantic family or answer label.

Freeze the task prompts, helper schema and description, parser source/runtime, source bytes and hashes, gold hashes, fixture author/verifier receipts, effective SDK prompt projections, selected model/provider compatibility, SF source list, arm orders, call bounds, timeout, and shared task/judge pacing parameters before predictions. Copy the selected pacing parameters explicitly into the successor protocol; this design does not read or assert their current values. Preserve the existing no-hidden-retry and bounded HTTP 429 cooldown/circuit behavior. The theoretical ceiling is 3,072 task requests plus 24 optional post-task representation judgments; actual physical calls, errors, cancelled queues, and unrun slots determine actual usage, not that ceiling.

**Prospective measurements and acceptance**

- Preserve every scheduled session, actual model request, tool call, tool error/recovery, HTTP failure, stream truncation, unknown usage/cache quantity, cancellation, cleanup result, and unrun slot. Never replace the first failed attempt with a rerun. A separate new campaign cannot erase an old failure.
- Host grade the untouched strict final JSON against the frozen gold object. An errored or incompletely cleaned-up workflow with a correct final answer is a `correctFinalAnswerObservation`, not an accepted workflow. Keep this distinction in every arm, stratum, denominator, and timing report.
- Report scheduled/observed/completed/accepted/error/unrun counts for A through D, with acceptance over the full scheduled population. Report paired accepted gains and losses for A:C and B:D, and raw:compact acceptance differences for A:B and C:D. Cluster uncertainty by authored case, with families fixed before prediction. Do not call a new fixture population a same-case improvement over the old campaign.
- Record whether the model chose the helper, each op/mode, arguments, results, source hashes, helper call counts, helper CPU elapsed time, model turns, total tool calls, and recovered invalid calls. Report wrong selector/operand choices separately from correctly computed results. Treat chosen-versus-unchosen helper subsets as diagnostics because selection is endogenous, not a randomized efficacy result.
- A model may recover a returned argument error through another real call within the frozen bounds. Retain the failed call and all its work. Only a fully completed correct workflow may be accepted; unresolved I/O, source mutation, provider, extension, timeout, or cleanup failure cannot be normalized away.
- Report numeric full-ledger prompt/completion/total tokens, cached and uncached prompt tokens, and unknown quantities separately. Sum known physical usage as a lower bound when the ledger is incomplete. A helper's short output and definition overhead both belong to the request totals. Do not assume that extra tool calls are free.
- Measure time to the accepted final answer and full workflow time including helper execution, provider calls, paced queue waits, and cleanup. Record queue wait, local helper time, compression transform time, and provider validation time separately. Full comparisons require accepted completed workflows and complete measurements; all-error strata have no latency samples. Paired accepted-only timings are explicitly partial diagnostics. Paced workflow timings do not establish provider-only speed.
- Measure tokens per accepted workflow using all scheduled physical work in the numerator and the full accepted count in the denominator; report unavailable when the accepted denominator is zero or usage is unknown. Do not infer currency savings from tokens without actual selected-model pricing and billing evidence.
- For compact arms, retain codec exact-round-trip checks and the existing eligible-case requirement for actual validated encoded provider text and the nonce-bound host manifest. Helper success cannot substitute for live hook intervention. Preserve unique-line controls and report full mixed-corpus overhead as well as predeclared eligible compression savings.
- After all task arms, the optional selected Grok representation judge can assess each fresh original/encoded pair without host gold, expected answer, or a corrected task response. Record all 24 scheduled judgments and require the exact strict schema's affirmative booleans plus an empty issue list to qualify that judge lane. Its opinion complements machine and task evidence; it is not a hidden grader used to repair answers.

A prospective helper DX success target is at least a five-percentage-point increase in full-population accepted workflows versus the corresponding read-only arm, no loss of accepted unique-line controls, and no increase in completely measured tokens per accepted workflow. Report all paired gains/losses and case-clustered uncertainty even if that target is met. Freeze this target or an explicitly selected replacement before predictions; never select it from observed successor outcomes.

The existing compression capacity hypotheses remain separately predeclared: at least 20% eligible prompt-token reduction, no increase in full mixed prompt tokens, no accepted-workflow regression, and accepted full-workflow timing gates assessed only when measurements qualify. Apply them within A:B and within C:D; do not combine unlike tool capabilities into one compression ratio. If helper arms improve task accuracy, that supports the helper capability. If compact helper arms also reduce prompt tokens without regression, that supports compression in that tool environment. Neither result establishes trained-model improvement or general production speed by itself.

This is a design proposal with invented CPU primitive checks. Implementation, source-blind fixture authoring, installed SDK dispatch verification, frozen new-protocol execution, autonomous helper use, fresh factual acceptance, Grok judgments, and any performance qualification remain future work.
