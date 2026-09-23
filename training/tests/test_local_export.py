"""Validate local bridge invariants with pure CPU objects and temporary files."""
import copy
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract
import local_export as export
from test_import_checkpoint import c11_receipts


def write_tokenizer(root, vocab_size=4):
    root.mkdir(parents=True, exist_ok=True)
    vocab = {"<bos>": 0, "<eos>": 1, "a": 2, "b": 3}
    documents = {
        "config.json": {"vocab_size": vocab_size},
        "tokenizer.json": {"model": {"vocab": vocab}, "added_tokens": [
            {"id": 0, "content": "<bos>", "special": True},
            {"id": vocab_size, "content": "<image_soft_token>", "special": True}]},
        "tokenizer_config.json": {"bos_token": "<bos>", "eos_token": "<eos>",
            "added_tokens_decoder": {"0": {"content": "<bos>", "special": True},
                str(vocab_size): {"content": "<image_soft_token>", "special": True}},
            "extra_special_tokens": {"image_token": "<image_soft_token>"}, "image_token_id": vocab_size},
        "added_tokens.json": {"<bos>": 0, "<image_soft_token>": vocab_size},
        "special_tokens_map.json": {"additional_special_tokens": ["<eos>", "<image_soft_token>"]},
    }
    for name, document in documents.items(): (root / name).write_text(json.dumps(document) + "\n")
    (root / "chat_template.jinja").write_text("source template stays byte-identical\n")
    return documents


class ExportTests(unittest.TestCase):
    def test_projection_removes_only_untrained_image_placeholder(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source, output = root / "source", root / "output"
            original = write_tokenizer(source); output.mkdir()
            (output / "tokenizer.model").write_text("generated stale tokenizer")
            source_hashes = {file.name: contract.sha256(file) for file in source.iterdir()}
            result = export.project_text_tokenizer(source, output, 4)
            tokenizer = json.loads((output / "tokenizer.json").read_text())
            config = json.loads((output / "tokenizer_config.json").read_text())
            self.assertEqual(tokenizer["model"], original["tokenizer.json"]["model"])
            self.assertEqual(tokenizer["added_tokens"], [original["tokenizer.json"]["added_tokens"][0]])
            self.assertEqual(config["bos_token"], "<bos>"); self.assertEqual(config["eos_token"], "<eos>")
            self.assertNotIn("4", config["added_tokens_decoder"]); self.assertNotIn("image_token_id", config)
            self.assertEqual(json.loads((output / "added_tokens.json").read_text()), {"<bos>": 0})
            self.assertEqual(json.loads((output / "special_tokens_map.json").read_text())["additional_special_tokens"], ["<eos>"])
            self.assertEqual((output / "chat_template.jinja").read_bytes(), (source / "chat_template.jinja").read_bytes())
            self.assertFalse((output / "tokenizer.model").exists())
            self.assertEqual(source_hashes, {file.name: contract.sha256(file) for file in source.iterdir()})
            self.assertEqual(result["removed_special_tokens"][0]["id"], 4)
            self.assertGreaterEqual(len(result["removed_special_tokens"][0]["occurrences"]), 6)
            self.assertEqual(result["export_files"]["tokenizer.json"], contract.sha256(output / "tokenizer.json"))

    def test_projection_rejects_unexpected_ids_duplicate_keys_and_vocab_rewrites(self):
        for change in ("id", "trained-content", "decoder-id", "special", "duplicate", "size"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); source = root / "source"; docs = write_tokenizer(source)
                if change == "id": docs["tokenizer.json"]["added_tokens"][1]["id"] = 5
                if change == "trained-content": docs["tokenizer.json"]["added_tokens"][0]["content"] = "b"
                if change == "decoder-id": docs["tokenizer_config.json"]["added_tokens_decoder"]["0"]["id"] = 1
                if change == "special": docs["tokenizer_config.json"]["eos_token"] = "foreign"
                for name, doc in docs.items(): (source / name).write_text(json.dumps(doc) + "\n")
                if change == "duplicate": (source / "tokenizer.json").write_text('{"model":{},"model":{}}')
                with self.assertRaises(ValueError): export.project_text_tokenizer(source, root / "out", 5 if change == "size" else 4)
                self.assertFalse((root / "out").exists())

    def test_fusion_requires_exact_training_pin_and_template(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / "fit.jsonl"; data.write_bytes(b"synthetic frozen rows")
            manifest = {"training_data_sha256": contract.sha256(data), "template_version": "v2"}
            with patch.object(export, "read_rows", return_value=[{"template_version": "v2"}]) as reader:
                path, rows = export.fusion_training_rows(root / "adapter", manifest, str(data))
                self.assertEqual(path, data.resolve()); reader.assert_called_once_with(path, "train")
            with self.assertRaises(ValueError): export.fusion_training_rows(root, {**manifest, "training_data_sha256": "f" * 64}, str(data))
            with patch.object(export, "read_rows", return_value=[{"template_version": "v1"}]), self.assertRaises(ValueError):
                export.fusion_training_rows(root, manifest, str(data))

    def test_exact_original_base_file_pins_are_checked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / "config.json").write_bytes(b"config"); (root / "model.safetensors").write_bytes(b"model")
            hashes = {file.name: contract.sha256(file) for file in root.iterdir()}
            with patch.object(contract, "BASE_HASHES", hashes), patch.object(contract, "verify_local_base"):
                export.verify_base_files(root)
                (root / "model.safetensors").write_bytes(b"different model")
                with self.assertRaisesRegex(ValueError, "pin differs"): export.verify_base_files(root)

    def test_adapter_validation_rejects_changed_lineage_bytes_and_local_provenance(self):
        for change in (None, "qualified", "lineage", "adapter", "helper", "data", "config", "source"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); adapter = root / "adapters.safetensors"; adapter.write_bytes(b"adapter")
                _, receipt, _, _, _ = c11_receipts()
                digest = contract.sha256(adapter); receipt["adapter_sha256"] = digest
                receipt["saved_adapter_reload"]["adapter_sha256"] = digest
                manifest = {"schema_version": 2, "template_version": "v2", "qualified": False,
                    "provenance": {"base_model": contract.BASE_MODEL, "base_revision": contract.BASE_REVISION, "training_backend": "torch_cuda"},
                    "adapter_sha256": digest, "training_data_sha256": contract.TRAIN_SHA256,
                    "cuda_campaign_sha256": receipt["source"]["campaign_sha256"], "cuda_source": receipt,
                    "local_precision": export.PRECISION, "local_architecture": export.local_architecture()}
                config = {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA}
                if change == "qualified": manifest["qualified"] = True
                if change == "lineage": manifest["provenance"]["base_model"] = "unapproved"
                if change == "adapter": adapter.write_bytes(b"drift")
                if change == "helper": manifest["local_architecture"]["helper_sha256"] = "f" * 64
                if change == "data": manifest["training_data_sha256"] = "f" * 64
                if change == "config": config["num_layers"] = 1
                if change == "source": manifest["cuda_source"]["source"]["initialization"] = "resume"
                contract.write_json(root / "adapter-manifest.json", manifest)
                contract.write_json(root / "adapter_config.json", config)
                if change is None: self.assertEqual(export.validate_adapter(root), manifest)
                else:
                    with self.assertRaises(ValueError): export.validate_adapter(root)

    def test_fusion_rejects_missing_failed_or_changed_local_import_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = {"cuda_source": {"adapter_sha256": "d" * 64}, "cuda_receipt_sha256": "f" * 64,
                "local_architecture": export.local_architecture(), "cuda_campaign_sha256": "c" * 64}
            with self.assertRaisesRegex(ValueError, "completed successful"): export.require_verified_import(root, manifest)
            margins = root / "local-fit-margins.jsonl"; margins.write_bytes(b"verified margins")
            comparison = {"ok": True, "rows": 327, "max_probability_delta": 0.01,
                "max_probability_delta_limit": 0.05, "decisive_margin": 0.5, "decisive_sign_flips": 0}
            report = {"ok": True, "reload_verified": True, "qualified": False, "training_backend": "torch_cuda",
                "cuda_source": manifest["cuda_source"], "cuda_receipt_sha256": manifest["cuda_receipt_sha256"],
                "local_architecture": manifest["local_architecture"], "local_precision": export.PRECISION,
                "cuda_campaign_sha256": manifest["cuda_campaign_sha256"], "cross_backend_equivalence": comparison,
                "local_fit_margins_sha256": contract.sha256(margins)}
            contract.write_json(root / "import-report.json", report)
            contract.write_json(root / "import-equivalence.json", comparison)
            export.require_verified_import(root, manifest)
            for key, value in (("reload_verified", False), ("qualified", True), ("local_fit_margins_sha256", "f" * 64)):
                changed = copy.deepcopy(report); changed[key] = value
                contract.write_json(root / "import-report.json", changed)
                with self.subTest(key=key), self.assertRaises(ValueError): export.require_verified_import(root, manifest)
            contract.write_json(root / "import-report.json", report)
            margins.write_bytes(b"changed margins")
            with self.assertRaises(ValueError): export.require_verified_import(root, manifest)

    def test_complete_tree_expands_before_helper_and_adapter_for_load_and_fusion(self):
        events = []
        class Parameter:
            def __init__(self, name, dtype): self.name, self.dtype = name, dtype
            def astype(self, dtype): events.append(("cast", self.name, dtype)); self.dtype = dtype; return self
        class Model:
            def __init__(self):
                self.tree = {"embedding": Parameter("embedding", "bf16"),
                    "layers": [{"query": Parameter("query", "bf16"), "value": Parameter("value", "float16")},
                        {"norm": Parameter("layer_norm", "fp32")}],
                    "norm": Parameter("final_norm", "bf16"), "integer": Parameter("integer", "int")}
            def parameters(self): return self.tree
            def update(self, value): events.append(("update", value))
        def tree_map(fn, value):
            if isinstance(value, dict): return {key: tree_map(fn, item) for key, item in value.items()}
            if isinstance(value, list): return [tree_map(fn, item) for item in value]
            return fn(value)
        mx = types.ModuleType("mlx.core"); mx.float32, mx.floating = "fp32", "floating"
        mx.issubdtype = lambda dtype, _: dtype in {"bf16", "float16", "fp32"}
        utils = types.ModuleType("mlx.utils"); utils.tree_map, utils.tree_unflatten = tree_map, lambda value: value
        package = types.ModuleType("mlx"); package.__path__ = []; package.core = mx
        lm = types.ModuleType("mlx_lm"); lm.__path__ = []
        tuner = types.ModuleType("mlx_lm.tuner.utils")
        saver = types.ModuleType("mlx_lm.utils"); saver.save = lambda *_args, **_kwargs: None
        architecture = types.ModuleType("gemma_fp32")
        architecture.install_fp32_embedding_scale = lambda model: events.append(("architecture", model))
        modules = {"mlx": package, "mlx.core": mx, "mlx.utils": utils, "mlx_lm": lm,
            "mlx_lm.tuner": types.ModuleType("mlx_lm.tuner"), "mlx_lm.tuner.utils": tuner,
            "mlx_lm.utils": saver, "gemma_fp32": architecture}
        manifest = {"local_precision": export.PRECISION}
        for stage in ("load", "fusion"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temporary:
                events.clear(); model = Model(); base = Path(temporary); (base / "config.json").write_text("{}")
                lm.load = lambda *_args, **kwargs: (events.append(("load", kwargs["adapter_path"])) or (model, None, {}))
                tuner.load_adapters = lambda *_args: events.append(("adapters", _args[1]))
                with patch.dict("sys.modules", modules), patch.object(export, "validate_architecture"), \
                    patch.object(export, "validate_adapter", return_value=manifest), patch.object(export, "validate_local_profile"), \
                    patch.object(export, "require_verified_import"):
                    if stage == "load": export.load_model(base, base / "adapter")
                    else:
                        def stop_at_adapter(*args): events.append(("adapters", args[1])); raise InterruptedError("fusion proof boundary")
                        tuner.load_adapters = stop_at_adapter
                        with patch.object(export, "provenance", return_value={}), \
                            patch.object(export, "fusion_training_rows", return_value=(base / "fit.jsonl", [])), \
                            patch.object(export, "resolve_model", return_value=base), patch.object(export, "verify_base_files"), \
                            patch.object(export, "load_tokenizer"), patch.object(export, "verify_prompt_parity"):
                            with self.assertRaisesRegex(InterruptedError, "proof boundary"):
                                export.run_with_progress(types.SimpleNamespace(adapter=str(base / "adapter"), data=str(base / "fit.jsonl"),
                                    model=str(base), output=str(base / "fused")), types.SimpleNamespace(emit=lambda *_args, **_kwargs: None))
                self.assertEqual([event[0] for event in events], ["load"] + ["cast"] * 5 + ["update", "architecture", "adapters"])
                self.assertEqual({event[1] for event in events if event[0] == "cast"}, {"embedding", "query", "value", "layer_norm", "final_norm"})
                self.assertIsNone(events[0][1]); self.assertEqual(model.tree["integer"].dtype, "int")


if __name__ == "__main__": unittest.main()
