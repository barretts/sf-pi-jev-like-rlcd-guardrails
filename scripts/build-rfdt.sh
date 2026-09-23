#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
python_command="${JEV_RFDT_BOOTSTRAP_PYTHON:-python3.13}"
task_venv="${JEV_RFDT_VENV:-$task_root/.build/rfdt-venv}"
with_converter=false
if [[ "${1:-}" == "--with-converter" ]]; then
  with_converter=true
elif [[ $# -gt 0 ]]; then
  printf '%s\n' 'Usage: scripts/build-rfdt.sh [--with-converter]' >&2
  exit 2
fi
"$python_command" -c 'import sys; assert sys.version_info[:2] == (3, 13), "Local F16 export requires Python 3.13"'
"$python_command" -m venv "$task_venv"
"$task_venv/bin/python" -m pip install -c "$task_root/training/local-export.lock" -r "$task_root/training/requirements-local-export.txt"
if $with_converter; then
  if [[ ! -f "$task_root/.vendor/llama.cpp/convert_hf_to_gguf.py" ]]; then
    printf '%s\n' 'Run scripts/build-native.sh first to obtain the pinned llama.cpp converter.' >&2
    exit 1
  fi
  "$task_venv/bin/python" -m pip install -c "$task_root/training/local-export.lock" 'torch==2.11.0' sentencepiece protobuf
  "$task_venv/bin/python" "$task_root/.vendor/llama.cpp/convert_hf_to_gguf.py" --help >/dev/null
fi
cd -- "$task_root"
"$task_venv/bin/python" -c 'import sys; sys.path.insert(0, "training"); import contract; print(contract.dependencies())'
