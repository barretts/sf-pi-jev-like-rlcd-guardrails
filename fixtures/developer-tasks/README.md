# Local TypeScript repair fixtures

These four tasks are independent, deliberately broken programs for paired developer-repair runs. Each task has one editable TypeScript source file, a fixed behavioral contract, fixed Node test-runner assertions, and a strict compiler configuration. None needs a package installation, network access, or a model.

Copy the complete task directory into a fresh workspace before running it. Run each manifest command with that workspace as its current directory, replacing the literal `{repo_root}` argument prefix with the repository's absolute path. Run acceptance commands in order and stop at the first nonzero exit. The compiler both checks types and produces task-local `.compiled` output; the tests import that output. Diagnostic commands have the same ordering.

Only files in `allowed_edit_files` may change. Tests, instructions, manifests, compiler settings, and package settings are acceptance inputs. Preload the files listed in `preloaded_source_files`, the instructions, and the unmodified initial failing command output into each paired arm. Do not preload a repair or a solution artifact.

| Task                | Contract under repair                                                                  | Initial failing stage         |
| ------------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| `nullable-contact`  | Normalize optional contact data without losing its nullable type or mutating input     | Strict TypeScript compilation |
| `abortable-refresh` | Share a pending request, reject cancellation promptly, and recover after every outcome | Behavioral tests              |
| `exclusive-window`  | Produce accurate half-open pagination windows, including the final and empty pages     | Behavioral tests              |
| `latest-request`    | Let the latest request alone update state, regardless of completion order              | Behavioral tests              |

The authored sources remain buggy. Correct-repair verification uses temporary copies outside this directory.
