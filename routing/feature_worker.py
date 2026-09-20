#!/usr/bin/env python3
"""Offline JSONL feature worker for the frozen official Google Gemma 3 1B base.

Launch with .build/rfdt-venv/bin/python -I routing/feature_worker.py.
Input: {"id": "...", "text": "..."}. Successful output includes 1152 finite
features, inputTokens (including BOS), elapsedMs, modelId, revision and exact
provenance. Errors contain a bounded code/message and never echo input text,
paths, exception details or credentials. Importing this module loads no model.
The CLI first emits a ready record after offline pin/tokenizer verification;
the decoder is loaded lazily on the first scheduled feature request.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import sys
import time
from typing import BinaryIO, Callable, Protocol, TextIO

MODEL_ID = "google/gemma-3-1b-it"
REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752"
MLX_LM_REVISION = "9d1e356e7cc6549e7d1697adabe2ea01ff8e062c"
ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / ".build/hf-session-1_s2hbhu/home/hub/models--google--gemma-3-1b-it/snapshots" / REVISION
FEATURE_DIM = 1152
VOCAB_SIZE = 262144
MAX_TOKENS = 2048
MAX_TEXT_BYTES = 32 * 1024
MAX_LINE_BYTES = 64 * 1024
MAX_DRAIN_BYTES = 4 * MAX_LINE_BYTES
MAX_OUTPUT_BYTES = 64 * 1024
MAX_REQUESTS = 4096
FREE_CACHE_BYTES = 256 * 1024 * 1024
MEMORY_GUIDELINE_BYTES = 8 * 1024 * 1024 * 1024
PREPROCESSING = "raw_text_official_tokenizer_add_special_tokens_true_BOS_no_chat_template_no_truncation_v1"
FILE_SHA256 = {
    "config.json": "19cb5d28c97778271ba2b3c3df47bf76bdd6706724777a2318b3522230afe91e",
    "generation_config.json": "fd9324becc53c4be610db39e13a613006f09fd6ef71a95fb6320dc33157490a3",
    "tokenizer.json": "4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795",
    "tokenizer.model": "1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c",
    "tokenizer_config.json": "bfe25c2735e395407beb78456ea9a6984a1f00d8c16fa04a8b75f2a614cf53e1",
    "special_tokens_map.json": "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397",
    "added_tokens.json": "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946",
    "model.safetensors": "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6",
}


class WorkerError(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


class Backend(Protocol):
    provenance: dict

    def encode(self, text: str) -> list[int]: ...
    def extract(self, tokens: list[int]) -> list[float]: ...
    def close(self) -> None: ...


def file_signature(path: Path) -> tuple:
    stat = path.stat()
    return (str(path.resolve()), stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def verify_file_bindings(directory: Path, expected: dict[str, str]) -> dict[str, tuple]:
    signatures = {}
    for name, checksum in expected.items():
        path = directory / name
        before = file_signature(path)
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                h.update(block)
        if h.hexdigest() != checksum or file_signature(path) != before:
            raise WorkerError("pin_mismatch", "Official base file identity verification failed")
        signatures[name] = before
    return signatures


def configure_offline() -> None:
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN", "HF_TOKEN_PATH"):
        os.environ.pop(key, None)
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1",
        "HF_HOME": str(ROOT / ".build/routing-offline-no-credentials"),
        "HF_TOKEN_PATH": str(ROOT / ".build/routing-offline-no-credentials/absent-token"),
        "TOKENIZERS_PARALLELISM": "false",
    })


def dependency_identity() -> dict:
    expected = {"mlx": "0.32.2", "mlx-lm": "0.32.0", "transformers": "5.11.0", "huggingface-hub": "1.32.0"}
    if platform.python_version() != "3.13.11":
        raise WorkerError("runtime_mismatch", "Pinned Python runtime is required")
    actual = {name: importlib.metadata.version(name) for name in expected}
    direct = importlib.metadata.distribution("mlx-lm").read_text("direct_url.json")
    if actual != expected or not direct or json.loads(direct).get("vcs_info", {}).get("commit_id") != MLX_LM_REVISION:
        raise WorkerError("runtime_mismatch", "Pinned feature runtime dependencies are required")
    return {"python": platform.python_version(), **actual, "mlx_lm_revision": MLX_LM_REVISION}


def last_hidden_features(decoder, mx, tokens: list[int]) -> list[float]:
    """Only the final RMS-normalized decoder state; no LM/vocabulary projection."""
    input_array = hidden = selected = None
    try:
        input_array = mx.array([tokens], dtype=mx.int32)
        hidden = decoder(input_array, cache=None)
        if tuple(hidden.shape) != (1, len(tokens), FEATURE_DIM):
            raise WorkerError("invalid_features", "Decoder feature shape is invalid")
        selected = mx.stop_gradient(hidden[0, -1, :].astype(mx.float32))
        mx.eval(selected)
        if mx.get_active_memory() > MEMORY_GUIDELINE_BYTES:
            raise WorkerError("resource_limit", "Feature extraction exceeded its active-memory check")
        return selected.tolist()
    finally:
        del selected, hidden, input_array
        mx.clear_cache()


class FrozenGemmaBackend:
    def __init__(self):
        configure_offline()
        self.mx = self.decoder = None
        self.previous_limits = None
        if not MODEL_DIR.is_dir() or MODEL_DIR.parent.parent.name != "models--google--gemma-3-1b-it":
            raise WorkerError("pin_mismatch", "Pinned local official base is unavailable")
        if {path.name for path in MODEL_DIR.glob("model*.safetensors")} != {"model.safetensors"}:
            raise WorkerError("pin_mismatch", "Official base weight inventory is invalid")
        self.signatures = verify_file_bindings(MODEL_DIR, FILE_SHA256)
        self.source_signature = file_signature(Path(__file__))
        source_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        if file_signature(Path(__file__)) != self.source_signature:
            raise WorkerError("pin_mismatch", "Feature worker source changed during identity verification")
        config = json.loads((MODEL_DIR / "config.json").read_text())
        architecture = {"model_type": "gemma3_text", "num_hidden_layers": 26,
                        "hidden_size": FEATURE_DIM, "intermediate_size": 6912,
                        "num_attention_heads": 4, "num_key_value_heads": 1,
                        "head_dim": 256, "vocab_size": VOCAB_SIZE}
        if any(config.get(key) != value for key, value in architecture.items()) or any(
            config.get(key) for key in ("quantization", "quantization_config", "model_file")
        ):
            raise WorkerError("pin_mismatch", "Official base architecture is invalid")
        dependencies = dependency_identity()
        from transformers import AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(MODEL_DIR), local_files_only=True, trust_remote_code=False, token=False,
        )
        self.provenance = {
            "model": MODEL_ID, "modelId": MODEL_ID, "revision": REVISION, "lineage": "Google Gemma 3",
            "modelWeightSha256": FILE_SHA256["model.safetensors"], "workerSourceSha256": source_sha256,
            "filesSha256": dict(FILE_SHA256), "dependencies": dependencies,
            "preprocessing": PREPROCESSING, "featureDefinition": "final_rmsnorm_decoder_last_token",
            "featureDimension": FEATURE_DIM, "adapterApplied": False,
            "lmHeadApplied": False, "trainable": False, "dtype": "official_base_unchanged_then_feature_float32",
            "maxInputTokens": MAX_TOKENS, "mlxFreeCacheLimitBytes": FREE_CACHE_BYTES,
            "mlxMemoryGuidelineBytes": MEMORY_GUIDELINE_BYTES,
            "memoryGuidelineIsHardPeakCap": False, "requiredDevice": "metal",
        }

    def check_bindings(self) -> None:
        if file_signature(Path(__file__)) != self.source_signature or any(
            file_signature(MODEL_DIR / name) != signature for name, signature in self.signatures.items()
        ):
            raise WorkerError("pin_mismatch", "Official base files changed during the worker lifetime")

    def encode(self, text: str) -> list[int]:
        self.check_bindings()
        tokens = self.tokenizer.encode(text, add_special_tokens=True, truncation=False)
        if not tokens or tokens[0] != self.tokenizer.bos_token_id:
            raise WorkerError("pin_mismatch", "Official raw-text BOS boundary is invalid")
        return tokens

    def extract(self, tokens: list[int]) -> list[float]:
        if self.decoder is None:
            import mlx.core as mx
            from mlx_lm.utils import load_model
            self.mx = mx
            if not mx.metal.is_available():
                raise WorkerError("runtime_mismatch", "This pinned worker requires the scheduled Metal runtime")
            mx.set_default_device(mx.gpu)
            self.previous_limits = (mx.set_memory_limit(MEMORY_GUIDELINE_BYTES), mx.set_cache_limit(FREE_CACHE_BYTES))
            model, _ = load_model(MODEL_DIR, lazy=True, strict=True, trust_remote_code=False)
            model.freeze()
            model.eval()
            self.decoder = model.model
            del model  # Retain only the decoder, never the outer LM head.
            mx.eval(self.decoder.parameters())
            mx.clear_cache()
        self.check_bindings()
        features = last_hidden_features(self.decoder, self.mx, tokens)
        self.check_bindings()
        return features

    def close(self) -> None:
        self.decoder = None
        if self.mx is not None:
            self.mx.clear_cache()
            if self.previous_limits is not None:
                self.mx.set_memory_limit(self.previous_limits[0])
                self.mx.set_cache_limit(self.previous_limits[1])
        self.previous_limits = None


def safe_id(value) -> str | int | None:
    if type(value) is int and 0 <= value <= 2**53 - 1:
        return value
    if isinstance(value, str) and value and all(ord(c) >= 32 for c in value):
        try:
            if len(value.encode("utf-8")) <= 128:
                return value
        except UnicodeError:
            pass
    return None


def parse_request(raw: bytes) -> dict:
    if not raw or len(raw) > MAX_LINE_BYTES:
        raise WorkerError("invalid_request", "JSONL request exceeds its byte limit")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    def reject_constant(_value):
        raise ValueError("nonfinite JSON")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise WorkerError("invalid_request", "Expected one finite JSON request") from None


class FeatureWorker:
    def __init__(self, loader: Callable[[], Backend] = FrozenGemmaBackend, clock=time.monotonic):
        self.loader, self.clock = loader, clock
        self.backend = None
        self.failed = False
        self.requests = 0

    def close(self) -> None:
        backend, self.backend = self.backend, None
        if backend is not None:
            with contextlib.suppress(Exception):
                backend.close()

    def load_backend(self) -> Backend:
        if self.backend is None:
            with contextlib.redirect_stdout(sys.stderr):
                self.backend = self.loader()
        return self.backend

    def ready(self) -> dict:
        try:
            response = {"type": "ready", "dimension": FEATURE_DIM,
                        "provenance": dict(self.load_backend().provenance)}
            if len(json.dumps(response, allow_nan=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
                raise WorkerError("invalid_features", "Extractor response exceeds its byte limit")
            return response
        except WorkerError as error:
            self.failed = True
            self.close()
            return {"id": None, "error": {"code": error.code, "message": error.message}}
        except Exception:
            self.failed = True
            self.close()
            return {"id": None, "error": {"code": "worker_unavailable", "message": "Pinned feature startup failed; explicitly restart the worker"}}

    def reserve_request(self) -> None:
        if self.failed:
            raise WorkerError("worker_unavailable", "Feature worker must be explicitly restarted")
        self.requests += 1
        if self.requests > MAX_REQUESTS:
            self.failed = True
            raise WorkerError("resource_limit", "Feature worker request limit reached")

    def handle(self, request, *, count_request: bool = True) -> dict:
        identifier = safe_id(request.get("id")) if isinstance(request, dict) else None
        started = self.clock()
        try:
            if count_request:
                self.reserve_request()
            elif self.failed:
                raise WorkerError("worker_unavailable", "Feature worker must be explicitly restarted")
            if not isinstance(request, dict) or set(request) != {"id", "text"} or identifier is None:
                raise WorkerError("invalid_request", "Expected only a bounded id and text")
            text = request["text"]
            try:
                valid_text = isinstance(text, str) and bool(text.strip()) and len(text.encode("utf-8")) <= MAX_TEXT_BYTES
            except UnicodeError:
                valid_text = False
            if not valid_text:
                raise WorkerError("invalid_request", "Expected nonblank text within its byte limit")
            backend = self.load_backend()
            with contextlib.redirect_stdout(sys.stderr):
                tokens = backend.encode(text)
            if not isinstance(tokens, list) or not tokens or any(type(t) is not int or not 0 <= t < VOCAB_SIZE for t in tokens):
                raise WorkerError("invalid_features", "Tokenizer returned invalid input tokens")
            if len(tokens) > MAX_TOKENS:
                raise WorkerError("input_too_long", "Input exceeds the token limit; no truncation is performed")
            with contextlib.redirect_stdout(sys.stderr):
                features = backend.extract(tokens)
            if not isinstance(features, list) or len(features) != FEATURE_DIM or any(
                type(v) not in (int, float) or not math.isfinite(v) for v in features
            ):
                raise WorkerError("invalid_features", "Extractor returned invalid finite features")
            elapsed = (self.clock() - started) * 1000
            if not math.isfinite(elapsed) or elapsed < 0:
                raise WorkerError("invalid_features", "Feature timing is invalid")
            response = {"id": identifier, "features": [float(v) for v in features],
                        "inputTokens": len(tokens), "elapsedMs": elapsed,
                        "modelId": MODEL_ID, "revision": REVISION,
                        "provenance": dict(self.backend.provenance)}
            if len(json.dumps(response, allow_nan=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
                raise WorkerError("invalid_features", "Extractor response exceeds its byte limit")
            return response
        except WorkerError as error:
            if error.code not in ("invalid_request", "input_too_long"):
                self.failed = True
                self.close()
            return {"id": identifier, "error": {"code": error.code, "message": error.message}}
        except Exception:
            self.failed = True
            self.close()
            return {"id": identifier, "error": {"code": "worker_unavailable", "message": "Pinned feature backend failed; explicitly restart the worker"}}


def serve(stdin: BinaryIO, stdout: TextIO, worker: FeatureWorker, *, announce_ready: bool = False) -> int:
    def emit(response):
        stdout.write(json.dumps(response, allow_nan=False, separators=(",", ":")) + "\n")
        stdout.flush()
    try:
        if announce_ready:
            emit(worker.ready())
            if worker.failed:
                return 1
        while True:
            raw = stdin.readline(MAX_LINE_BYTES + 1)
            if not raw:
                return 1 if worker.failed else 0
            try:
                worker.reserve_request()  # Includes malformed JSON and oversized records.
                if len(raw) > MAX_LINE_BYTES:
                    drained = len(raw)
                    while not raw.endswith(b"\n"):
                        remaining = MAX_DRAIN_BYTES - drained
                        if remaining <= 0:
                            worker.failed = True
                            raise WorkerError("resource_limit", "Oversized JSONL request exceeded its drain limit")
                        raw = stdin.readline(min(MAX_LINE_BYTES + 1, remaining))
                        drained += len(raw)
                        if not raw:
                            break
                    raise WorkerError("invalid_request", "JSONL request exceeds its byte limit")
                response = worker.handle(parse_request(raw), count_request=False)
            except WorkerError as error:
                response = {"id": None, "error": {"code": error.code, "message": error.message}}
            emit(response)
            if worker.failed:
                return 1
    finally:
        worker.close()


if __name__ == "__main__":
    if len(sys.argv) != 1:
        sys.stderr.write("Feature worker accepts no model, adapter, fetch or configuration overrides.\n")
        sys.exit(2)
    try:
        sys.exit(serve(sys.stdin.buffer, sys.stdout, FeatureWorker(), announce_ready=True))
    except (BrokenPipeError, KeyboardInterrupt):
        sys.exit(1)
