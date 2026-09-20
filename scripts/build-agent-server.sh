#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=f072b103714dfa1eee531f80b24512faf38e3dd2
if [[ ! -d .vendor/llama.cpp/.git ]]; then
  git init .vendor/llama.cpp
  git -C .vendor/llama.cpp remote add origin https://github.com/ggml-org/llama.cpp.git
fi
if [[ "$(git -C .vendor/llama.cpp rev-parse HEAD 2>/dev/null || true)" != "$revision" ]]; then
  git -C .vendor/llama.cpp fetch --depth 1 origin "$revision"
  git -C .vendor/llama.cpp checkout --detach "$revision"
fi
cmake -S .vendor/llama.cpp -B .build/agent-server -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TOOLS=ON \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF
cmake --build .build/agent-server --target llama-server -j 4
