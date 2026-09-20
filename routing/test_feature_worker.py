"""Invented CPU contract checks. No MLX/model/tokenizer/native/GPU imports."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("feature_worker", Path(__file__).with_name("feature_worker.py"))
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)


class FakeBackend:
    def __init__(self, tokens=None, features=None):
        self.tokens = [2, 10, 11] if tokens is None else tokens
        self.features = [i / 1000 for i in range(feature.FEATURE_DIM)] if features is None else features
        self.provenance = {"inventedCpuFixture": True, "officialFilesVerified": False}
        self.extract_calls = 0
        self.closed = False

    def encode(self, text):
        return self.tokens

    def extract(self, tokens):
        self.extract_calls += 1
        return self.features

    def close(self):
        self.closed = True


class FakeTensor:
    def __init__(self, values, shape):
        self.values, self.shape = values, shape

    def __getitem__(self, selection):
        if selection != (0, -1, slice(None)):
            raise AssertionError("Only the final decoder hidden row may be selected")
        return FakeTensor(self.values, (feature.FEATURE_DIM,))

    def astype(self, dtype):
        return self

    def tolist(self):
        return self.values


class FakeMx:
    int32, float32 = "fake-int32", "fake-float32"

    def __init__(self):
        self.gradient_stopped = self.materialized = False
        self.clear_count = 0
        self.active_bytes = 0

    def array(self, values, dtype):
        assert dtype == self.int32
        return values

    def stop_gradient(self, value):
        self.gradient_stopped = True
        return value

    def eval(self, value):
        self.materialized = True

    def get_active_memory(self):
        return self.active_bytes

    def clear_cache(self):
        self.clear_count += 1


class FeatureWorkerTests(unittest.TestCase):
    def test_lazy_persistent_loader_and_success_contract(self):
        backend = FakeBackend()
        calls = []
        worker = feature.FeatureWorker(lambda: calls.append(True) or backend)
        self.assertEqual(calls, [])
        first = worker.handle({"id": "invented-1", "text": "invented plain text"})
        second = worker.handle({"id": "invented-2", "text": "different invented text"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(first["features"], backend.features)
        self.assertEqual(len(second["features"]), 1152)
        self.assertEqual(first["inputTokens"], 3)
        self.assertEqual(first["modelId"], feature.MODEL_ID)
        self.assertEqual(first["revision"], feature.REVISION)
        self.assertGreaterEqual(first["elapsedMs"], 0)
        self.assertEqual(first["provenance"], backend.provenance)
        worker.close()
        self.assertTrue(backend.closed)

    def test_ready_handshake_uses_persistent_backend_without_forward(self):
        backend = FakeBackend()
        calls = []
        worker = feature.FeatureWorker(lambda: calls.append(True) or backend)
        output = io.StringIO()
        code = feature.serve(io.BytesIO(), output, worker, announce_ready=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(backend.extract_calls, 0)
        self.assertEqual(json.loads(output.getvalue()), {
            "type": "ready", "dimension": 1152, "provenance": backend.provenance,
        })
        self.assertTrue(backend.closed)

    def test_ready_failure_is_bounded_and_does_not_consume_requests(self):
        def loader():
            raise RuntimeError("private token/path/input must never appear")
        stream = io.BytesIO(b'{"id":1,"text":"invented"}\n')
        output = io.StringIO()
        code = feature.serve(stream, output, feature.FeatureWorker(loader), announce_ready=True)
        response = json.loads(output.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(stream.tell(), 0)
        self.assertEqual(response["error"]["code"], "worker_unavailable")
        self.assertNotIn("private", output.getvalue())

    def test_safe_integer_ids_roundtrip_and_reject_unsafe_numbers(self):
        worker = feature.FeatureWorker(FakeBackend)
        for identifier in [0, 1, 2**53 - 1]:
            response = worker.handle({"id": identifier, "text": "invented"})
            self.assertEqual(response["id"], identifier)
            self.assertIn("features", response)
        for identifier in [True, False, -1, 2**53, 1.0, None]:
            response = worker.handle({"id": identifier, "text": "invented"})
            self.assertEqual(response["error"]["code"], "invalid_request")
        worker.close()

    def test_invalid_input_does_not_load_backend_or_echo_text(self):
        calls = []
        worker = feature.FeatureWorker(lambda: calls.append(True) or FakeBackend())
        invalid = [None, [], {}, {"id": "a", "text": " "}, {"id": "a", "text": 1},
                   {"id": "a", "text": "x", "adapter": "forbidden"},
                   {"id": "a", "text": "x" * (feature.MAX_TEXT_BYTES + 1)},
                   {"id": "bad\nline", "text": "x"}, {"id": "x" * 129, "text": "x"},
                   {"id": "a", "text": "\ud800"}]
        for request in invalid:
            response = worker.handle(request)
            self.assertEqual(response["error"]["code"], "invalid_request")
            self.assertNotIn("features", response)
            self.assertNotIn("text", response)
        self.assertEqual(calls, [])

    def test_json_rejects_duplicate_keys_nonfinite_invalid_utf8_and_nested_scalars(self):
        for raw in [b'{"id":"a","id":"b","text":"x"}', b'{"id":"a","text":NaN}',
                    b'{"id":"a","text":Infinity}', b'\xff', b'{']:
            with self.assertRaises(feature.WorkerError):
                feature.parse_request(raw)
        self.assertEqual(feature.parse_request(b'{"id":"a","text":"x"}'), {"id": "a", "text": "x"})

    def test_token_limit_rejects_without_forward_or_truncation(self):
        backend = FakeBackend(tokens=list(range(feature.MAX_TOKENS + 1)))
        worker = feature.FeatureWorker(lambda: backend)
        response = worker.handle({"id": "long", "text": "invented"})
        self.assertEqual(response["error"]["code"], "input_too_long")
        self.assertEqual(backend.extract_calls, 0)
        self.assertFalse(worker.failed)

    def test_invalid_features_fail_close_and_cannot_be_reused(self):
        for values in [[0.0], [float("nan")] * 1152, [float("inf")] * 1152, [True] * 1152]:
            backend = FakeBackend(features=values)
            worker = feature.FeatureWorker(lambda: backend)
            response = worker.handle({"id": "bad", "text": "invented"})
            self.assertEqual(response["error"]["code"], "invalid_features")
            self.assertTrue(backend.closed)
            self.assertTrue(worker.failed)
            self.assertEqual(worker.handle({"id": "later", "text": "x"})["error"]["code"], "worker_unavailable")

    def test_invalid_token_ids_and_safe_backend_exceptions(self):
        for tokens in [[True], [-1], [feature.VOCAB_SIZE], [], (2, 3)]:
            backend = FakeBackend(tokens=tokens)
            response = feature.FeatureWorker(lambda: backend).handle({"id": "bad", "text": "invented"})
            self.assertEqual(response["error"]["code"], "invalid_features")
            self.assertEqual(backend.extract_calls, 0)
        def broken_loader():
            raise RuntimeError("private input, local path, credential must never appear")
        response = feature.FeatureWorker(broken_loader).handle({"id": "safe", "text": "private text"})
        self.assertEqual(response["error"]["code"], "worker_unavailable")
        self.assertNotIn("private", json.dumps(response))
        self.assertNotIn("credential", json.dumps(response))

    def test_bounded_jsonl_drains_oversized_line_and_processes_next_request(self):
        backend = FakeBackend()
        stream = io.BytesIO(b'x' * (feature.MAX_LINE_BYTES * 2) + b'\n' + b'{"id":"valid","text":"invented"}\n')
        output = io.StringIO()
        code = feature.serve(stream, output, feature.FeatureWorker(lambda: backend))
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(code, 0)
        self.assertEqual(len(responses), 2)
        self.assertIsNone(responses[0]["id"])
        self.assertEqual(responses[0]["error"]["code"], "invalid_request")
        self.assertEqual(responses[1]["id"], "valid")
        self.assertEqual(len(responses[1]["features"]), 1152)
        self.assertTrue(backend.closed)

    def test_bad_records_count_and_unterminated_oversize_drain_is_bounded(self):
        for raw in [b'{\n', b'x' * (feature.MAX_LINE_BYTES + 1) + b'\n']:
            backend = FakeBackend()
            calls = []
            worker = feature.FeatureWorker(lambda: calls.append(True) or backend)
            output = io.StringIO()
            with patch.object(feature, "MAX_REQUESTS", 2):
                code = feature.serve(io.BytesIO(raw * 4), output, worker)
            responses = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(code, 1)
            self.assertEqual(len(responses), 3)
            self.assertEqual(worker.requests, 3)
            self.assertEqual(responses[-1]["error"]["code"], "resource_limit")
            self.assertEqual(calls, [])
        worker = feature.FeatureWorker(lambda: self.fail("No backend load on oversized input"))
        stream = io.BytesIO(b'x' * (feature.MAX_DRAIN_BYTES * 2))
        output = io.StringIO()
        self.assertEqual(feature.serve(stream, output, worker), 1)
        self.assertEqual(stream.tell(), feature.MAX_DRAIN_BYTES)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "resource_limit")

    def test_decoder_last_hidden_path_never_calls_lm_head_and_clears_buffers(self):
        mx = FakeMx()
        calls = []
        def decoder(tokens, cache):
            self.assertIsNone(cache)
            calls.append(tokens)
            return FakeTensor([0.25] * 1152, (1, len(tokens[0]), 1152))
        result = feature.last_hidden_features(decoder, mx, [2, 5, 6])
        self.assertEqual(result, [0.25] * 1152)
        self.assertEqual(calls, [[[2, 5, 6]]])
        self.assertTrue(mx.gradient_stopped)
        self.assertTrue(mx.materialized)
        self.assertEqual(mx.clear_count, 1)
        mx.active_bytes = feature.MEMORY_GUIDELINE_BYTES + 1
        with self.assertRaises(feature.WorkerError):
            feature.last_hidden_features(decoder, mx, [2])
        self.assertEqual(mx.clear_count, 2)

    def test_file_pin_mismatch_fails_without_any_model_loader(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "invented.bin").write_bytes(b"invented CPU bytes")
            checksum = hashlib.sha256(b"invented CPU bytes").hexdigest()
            signatures = feature.verify_file_bindings(directory, {"invented.bin": checksum})
            self.assertEqual(signatures["invented.bin"], feature.file_signature(directory / "invented.bin"))
            with self.assertRaises(feature.WorkerError):
                feature.verify_file_bindings(directory, {"invented.bin": "0" * 64})

    def test_request_count_and_output_limits_are_checked(self):
        backend = FakeBackend()
        worker = feature.FeatureWorker(lambda: backend)
        worker.requests = feature.MAX_REQUESTS
        response = worker.handle({"id": "limit", "text": "invented"})
        self.assertEqual(response["error"]["code"], "resource_limit")
        self.assertEqual(backend.extract_calls, 0)
        backend.provenance = {"invented": "x" * feature.MAX_OUTPUT_BYTES}
        response = feature.FeatureWorker(lambda: backend).handle({"id": "output", "text": "invented"})
        self.assertEqual(response["error"]["code"], "invalid_features")


if __name__ == "__main__":
    unittest.main()
