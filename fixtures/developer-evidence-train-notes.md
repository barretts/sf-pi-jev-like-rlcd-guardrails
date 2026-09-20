# Developer evidence TRAIN supplement

`developer-evidence-train.jsonl` contains 240 independently authored synthetic
TRAIN records over 90 source contexts. It is an adaptive follow-up to the full
512-step routing/diagnosis comparison, whose candidate improved diagnosis but
failed developer truth, uncertainty, and score quality. Existing evaluation
targets and thresholds remain unchanged.

The author used a supplied 12-record TRAIN style sample and the public request,
quality, and recipe schemas. No model, teacher, tokenizer, network, or evaluation
predictions were used for authoring. Independent semantic review checked all
90 source answers and 90 score condition credits. ROOT separately inspected all
90 contexts and checked all expanded targets and condition sums. One replacement
gold was disclosed during authoring progress, so the second review is independent
semantic checking rather than a fully blinded experiment.

| Type  | Distinct source groups | Records | Design                                                   |
| ----- | ---------------------: | ------: | -------------------------------------------------------- |
| Noul  |                     60 |     120 | 20 true, 20 false, 20 unknown; state and equivalent chat |
| Score |                     30 |     120 | State/chat and forward/reverse condition order           |

The score maximum is the last ordinal rubric index, `criteria.length - 1`.
There are 12 source rubrics with maximum 2, six with maximum 3, and 12 with maximum 4. Six source groups occur at each normalized target 0, 0.25, 0.5, 0.75, and 1.
Every established condition earns one point; half credit is permitted only by an
explicit condition rule. The 90 source condition credits comprise 41 zeros,
eight half points, and 41 full points. Production targets retain only the
required `{answer}` field; internal derivation keys are absent from instructions.
Condition order changes while ordinal answer levels retain their order.

Contexts cover encoding, parsing, arithmetic/indexing, database constraints and
rollback, filesystem verification, Git identity/diffs, dependency resolution,
pagination, error reports, compiler constants, dates, and compression. Stated
trusted traces are synthetic source evidence. They are not measurements of a
real developer, deployment, or service.

ROOT independently used the unchanged production CPU parser and logical
compiler for all 240 records and 480 v1/v2 compilations. IDs, groups, and exact
canonical contexts are disjoint from the existing legacy/developer corpora,
choice TRAIN supplement, and diagnosis VALIDATION corpus. That mechanical check
does not prove arbitrary semantic independence. No protected TEST scenario was
emitted or retained in the authoring/review evidence, and no protected target
entered optimizer construction.

Raw SHA-256 is
`a2252720fc7da7ad2aa2bd2a71fe231ceed866ddc49d44429c241cfad01ba54b`.
Maximum context length is 327 UTF-8 bytes; maximum compiled message length is
2,624 bytes for v2 and 5,202 bytes for v1. Byte limits do not prove native token
fit. The actual prepare/train stages must reject overlong contexts without
truncation.

The frozen follow-up uses the previous 730 TRAIN rows plus these 240 rows:
970 records over 415 groups, comprising 350 choice, 310 Noul, and 310 score
records. It starts from the pinned official Google Gemma 3 1B base with the same
512 updates, seed, selected-label objective, LoRA, optimizer, full-context v2
compiler, and native runtime. Its previous 730-row control has already been
observed. This is an adaptive comparison of an entire corpus change: effective
passes decrease from 5.611 to 4.223, original-row exposure decreases by 24.74%,
class sampling changes, and new content/instructions and variant weights are
introduced. It cannot isolate the semantic effect from those changes.

All legacy 60, developer 78, and diagnosis 56 VALIDATION records are required;
both original quality suites, unknown Noul MAE at most 0.1, complete coverage,
zero execution failures, and diagnosis accuracy at least 95% remain mandatory.
No TEST or permanent approval occurs automatically. A training or standalone
classifier result cannot establish a complete developer-workflow improvement.

The private frozen protocol is
`.build/improvement-experiments/evidence-supervision-comparison/protocol.json`,
SHA-256 `287da1f64c43524ac5aaa255c7647e831553c0fd2d7d795374c147379eb6fbbf`.
The combined optimizer input SHA-256 is
`720f5f1a19ab145779649d44ac953e8c1aeff7a36c39d39649272922a2604a12`.
The separate root review proof, source rationales, condition credit sidecars,
independent review, and logical branch hashes remain in the ignored
`evidence-supervision-proposal` experiment directory.
