import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import campaign


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / "recipe.json"
SOURCE_PLAN = ROOT / "data/objective.json"


def fake_modules(torch, save_file=None, load_file=None):
    return {"torch": torch, "safetensors": SimpleNamespace(),
            "safetensors.torch": SimpleNamespace(save_file=save_file or Mock(),
                                                  load_file=load_file or Mock())}


class C11CampaignTests(unittest.TestCase):
    def setUp(self):
        runtime = patch.object(campaign, "runtime_versions", return_value={"python": "3.13.11", **json.loads(PLAN.read_text())["runtime"]})
        self.runtime = runtime.start()
        self.addCleanup(runtime.stop)
        self.plan = campaign.load_campaign(PLAN)
        self.definition = json.loads(SOURCE_PLAN.read_text())
        self.args = SimpleNamespace(mode="train", steps=1024,
                                    budget_bytes=8_000_000_000,
                                    allocator_cap_bytes=6_500_000_000,
                                    campaign=str(PLAN), campaign_sha256=campaign.contract.sha256(PLAN), base="/original-google-gemma-base")

    def test_config_preserves_frozen_training_contract_and_names_sampler_override(self):
        self.assertEqual(self.plan["purpose"], "c11_fit_only_cuda_training")
        self.assertEqual((self.plan["fit_rows"], self.plan["explicit_pairs"],
                          self.plan["supplement_rows_admitted"]), (327, 86, 0))
        self.assertEqual(self.plan["prepared_fit_sha256"], campaign.objective.TRAIN_SHA256)
        self.assertEqual(self.plan["pair_manifest_sha256"], campaign.objective.PAIR_SHA256)
        self.assertEqual(self.plan["family_manifest_sha256"], campaign.objective.FAMILY_SHA256)
        self.assertEqual(self.plan["objective_plan_sha256"], campaign.objective.PLAN_SHA256)
        self.assertEqual(self.plan["sampler"]["implementation"], "sampler.FitSampler")
        self.assertEqual(self.plan["sampler"]["initial_pair_coverage"],
                         "one_shuffled_pass_over_all_explicit_pairs")
        self.assertNotEqual(self.plan["sampler"], self.definition["sampler"])
        self.assertEqual(self.plan["initialization"],
                         "original_google_gemma_base_fresh_lora_empty_optimizer")

    def test_changed_config_bytes_fail_before_contract_or_model_loading(self):
        for original, changed in (("1024", "1025"), ("0.0001", "0.0002"),
                                  ("float32", "float16"), ("327", "351")):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "campaign.json"
                path.write_text(PLAN.read_text().replace(original, changed))
                args = copy.copy(self.args)
                args.campaign = str(path)
                args.output = str(Path(directory) / "run")
                with patch.object(campaign.objective, "load_contract") as load_contract, \
                        patch.object(campaign, "load_model") as load_model:
                    with self.assertRaises(ValueError):
                        campaign.run(args)
                    load_contract.assert_not_called()
                    load_model.assert_not_called()

    def test_executed_module_source_pins_fail_on_changed_imported_files(self):
        for name, module in (("contract.py", campaign.contract),
                             ("cuda_train.py", campaign.objective),
                             ("sampler.py", campaign.fit_sampler)):
            with self.subTest(source=name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / name
                path.write_bytes(Path(module.__file__).read_bytes() + b"\n")
                args = copy.copy(self.args)
                args.output = str(Path(directory) / "run")
                with patch.object(module, "__file__", str(path)), \
                        patch.object(campaign.objective, "load_contract") as load_contract, \
                        patch.object(campaign, "load_model") as load_model:
                    with self.assertRaises(ValueError):
                        campaign.run(args)
                    load_contract.assert_not_called()
                    load_model.assert_not_called()

    def test_frozen_arguments_and_probe(self):
        self.assertEqual(campaign.validate_args(self.args, self.plan),
                         (1024, [128, 256, 512, 1024]))
        for key, value in (("steps", 256), ("mode", "resume"),
                           ("budget_bytes", 8 * 1024**3),
                           ("allocator_cap_bytes", 7_000_000_000)):
            with self.subTest(argument=key):
                args = copy.copy(self.args)
                setattr(args, key, value)
                with patch.object(campaign.objective, "load_contract") as load_contract, \
                        patch.object(campaign, "load_model") as load_model:
                    with self.assertRaises(ValueError):
                        campaign.run(args)
                    load_contract.assert_not_called()
                    load_model.assert_not_called()
        self.args.mode = "probe"
        with self.assertRaises(ValueError):
            campaign.validate_args(self.args, self.plan)
        self.args.steps = 1
        self.assertEqual(campaign.validate_args(self.args, self.plan), (1, [1]))

    def test_existing_output_fails_before_loading_contract_or_model(self):
        with tempfile.TemporaryDirectory() as directory:
            self.args.output = directory
            with patch.object(campaign.objective, "load_contract") as load_contract, \
                    patch.object(campaign, "load_model") as load_model:
                with self.assertRaisesRegex(ValueError, "fresh campaign path"):
                    campaign.run(self.args)
                load_contract.assert_not_called()
                load_model.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_runtime_mismatch_fails_before_output_or_model_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            self.args.output = str(Path(directory) / "run")
            self.runtime.side_effect = ValueError("declared pinned training profile")
            with patch.object(campaign.objective, "load_contract", return_value=([], [], {}, self.definition)), \
                    patch.object(campaign, "load_model") as load_model:
                with self.assertRaisesRegex(ValueError, "declared pinned training profile"):
                    campaign.run(self.args)
                load_model.assert_not_called()
            self.assertFalse(Path(self.args.output).exists())

    def test_cancellation_retains_c11_plan_and_failed_exit_without_checkpoint(self):
        torch = SimpleNamespace(device=lambda _: "cuda:0", cuda=SimpleNamespace(
            mem_get_info=lambda _: (_ for _ in ()).throw(InterruptedError("owned cancel"))))
        with tempfile.TemporaryDirectory() as directory:
            self.args.output = str(Path(directory) / "run")
            before = copy.deepcopy(self.definition)
            with patch.dict("sys.modules", fake_modules(torch)), patch.object(
                    campaign.objective, "load_contract", return_value=([], [], {}, self.definition)):
                with self.assertRaises(InterruptedError):
                    campaign.run(self.args)
            output = Path(self.args.output)
            exit_record = json.loads((output / "exit.json").read_text())
            self.assertEqual((exit_record["ok"], exit_record["canceled"],
                              exit_record["steps_completed"]), (False, True, 0))
            plan = json.loads((output / "plan.json").read_text())
            self.assertEqual(plan["experiment"], "c11")
            self.assertEqual(plan["source_objective_plan"], before)
            self.assertEqual(plan["objective"]["purpose"], "c11_train_only")
            self.assertEqual(plan["objective"]["sampler"], self.plan["sampler"])
            self.assertEqual(plan["objective"]["loss"], before["loss"])
            self.assertEqual(plan["objective"]["steps"], 1024)
            self.assertEqual(plan["sampler_source_sha256"],
                             self.plan["source_sha256"]["sampler.py"])
            self.assertEqual(self.definition, before)
            self.assertFalse((output / "checkpoints").exists())

    def test_fresh_base_lora_and_empty_optimizer_before_first_update(self):
        safe = {"source_id": "safe", "group": "fit-group", "target_probabilities": [1, 0]}
        risky = {"source_id": "risky", "group": "fit-group", "target_probabilities": [0, 1]}
        rows = [safe, risky]
        pairs = [{"pair_id": "fit-pair", "group_id": "fit-group", "safe": safe, "risky": risky}]
        families = {"safe": "shell", "risky": "shell"}
        torch = SimpleNamespace(device=lambda _: "cuda:0", manual_seed=Mock(), cuda=SimpleNamespace(
            mem_get_info=lambda _: (8_000_000_000, 16_000_000_000),
            set_per_process_memory_fraction=Mock(), reset_peak_memory_stats=Mock(), manual_seed_all=Mock()))
        model = SimpleNamespace(gradient_checkpointing_enable=Mock(), train=Mock())
        parameter = SimpleNamespace(detach=lambda: SimpleNamespace(clone=lambda: object()))
        saved_load = Mock()
        captured = []
        def first_update(parameters, state, *, lr):
            captured.append((parameters, dict(state), lr))
            raise InterruptedError("stop before first mocked update")
        with tempfile.TemporaryDirectory() as directory:
            self.args.output = str(Path(directory) / "run")
            with patch.dict("sys.modules", fake_modules(torch, load_file=saved_load)), \
                    patch.object(campaign.objective, "load_contract", return_value=(rows, pairs, families, self.definition)), \
                    patch.object(campaign.contract, "load_tokenizer", return_value=object()), \
                    patch.object(campaign.contract, "verify_prompt_parity", return_value={"ok": True}), \
                    patch.object(campaign, "load_model", return_value=model) as base_load, \
                    patch.object(campaign.objective, "attach_lora", return_value=[("fresh-lora", parameter)]) as attach_lora, \
                    patch.object(campaign.objective, "score_rows", return_value=({"safe": 0.0, "risky": 0.0}, 0.0)), \
                    patch.object(campaign.fit_sampler, "FitSampler", wraps=campaign.fit_sampler.FitSampler) as sampler, \
                    patch.object(campaign.objective, "train_unit", return_value=1.0) as train_unit, \
                    patch.object(campaign.objective, "assert_cuda_placement_before_step", return_value={}), \
                    patch.object(campaign.objective, "no_bias_adam_step", side_effect=first_update):
                with self.assertRaises(InterruptedError):
                    campaign.run(self.args)
                base_load.assert_called_once_with(Path(self.args.base), "cuda:0")
                attach_lora.assert_called_once_with(model)
                sampler.assert_called_once_with(rows, pairs, families, 42)
                self.assertEqual(train_unit.call_count, 8)
                saved_load.assert_not_called()
            self.assertEqual(captured, [([parameter], {}, 1e-4)])
            self.assertFalse((Path(self.args.output) / "checkpoints").exists())

    def test_base_loader_retains_local_google_gemma_fp32_eager_and_tied_embedding(self):
        weight = SimpleNamespace(data_ptr=lambda: 42)
        model = SimpleNamespace(config=SimpleNamespace(tie_word_embeddings=True, use_cache=True),
                                lm_head=SimpleNamespace(weight=weight),
                                model=SimpleNamespace(embed_tokens=SimpleNamespace(weight=weight)))
        model.to = Mock(return_value=model)
        factory = Mock(return_value=model)
        torch = SimpleNamespace(float32=object(), backends=SimpleNamespace(
            cuda=SimpleNamespace(matmul=SimpleNamespace(allow_tf32=True)),
            cudnn=SimpleNamespace(allow_tf32=True)))
        with patch.dict("sys.modules", {"torch": torch, "transformers": SimpleNamespace(
                Gemma3ForCausalLM=SimpleNamespace(from_pretrained=factory))}):
            self.assertIs(campaign.load_model(Path(self.args.base), "cuda:0"), model)
        factory.assert_called_once_with(self.args.base, local_files_only=True,
                                        dtype=torch.float32, attn_implementation="eager")
        self.assertFalse(model.config.use_cache)
        self.assertFalse(torch.backends.cuda.matmul.allow_tf32)
        self.assertFalse(torch.backends.cudnn.allow_tf32)
        model.lm_head.weight = SimpleNamespace(data_ptr=lambda: 43)
        with patch.dict("sys.modules", {"torch": torch, "transformers": SimpleNamespace(
                Gemma3ForCausalLM=SimpleNamespace(from_pretrained=factory))}):
            with self.assertRaisesRegex(ValueError, "tied Google Gemma"):
                campaign.load_model(Path(self.args.base), "cuda:0")

    def test_memory_nonfinite_and_saved_reload_guards_remain_strict(self):
        campaign.validate_memory({"peak_reserved_bytes": 6_500_000_000,
                                  "cuda_free_delta_bytes": 7_499_999_999}, self.plan)
        for memory in ({"peak_reserved_bytes": 6_500_000_001, "cuda_free_delta_bytes": 0},
                       {"peak_reserved_bytes": 0, "cuda_free_delta_bytes": 7_500_000_000}):
            with self.assertRaises(ValueError):
                campaign.validate_memory(memory, self.plan)
        for losses in ([], [float("nan")], [float("inf")]):
            with self.assertRaises(ValueError):
                campaign.mean_loss(losses)
        self.assertFalse(campaign.compare_reload({"safe": 1}, {"safe": 1.01})["ok"])
        with self.assertRaises(ValueError):
            campaign.compare_reload({"safe": 1}, {"risky": 1})


class RuntimeProfileTests(unittest.TestCase):
    def test_actual_versions_are_recorded_and_wrong_cuda_profile_rejected(self):
        modules = {"torch": SimpleNamespace(__version__="2.10.0+cu128", version=SimpleNamespace(cuda="12.8")),
                   "transformers": SimpleNamespace(__version__="5.11.0"), "safetensors": SimpleNamespace(__version__="0.8.0")}
        with patch.dict("sys.modules", modules):
            versions = campaign.runtime_versions()
            self.assertEqual(versions["cuda"], "12.8")
            self.assertIn("python", versions)
            modules["torch"].__version__="2.11.0"
            with self.assertRaisesRegex(ValueError,"declared pinned training profile"):
                campaign.runtime_versions()


if __name__ == "__main__":
    unittest.main()
