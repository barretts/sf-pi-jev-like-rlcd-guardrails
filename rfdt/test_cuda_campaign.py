import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import cuda_campaign as campaign


PLAN = Path(__file__).resolve().parents[1] / 'fixtures/guardrail/candidate10/cuda-campaign.json'


class CampaignTests(unittest.TestCase):
    def setUp(self):
        self.plan = campaign.load_campaign(PLAN)
        self.args = SimpleNamespace(mode='train', steps=1024, budget_bytes=8_000_000_000,
                                    allocator_cap_bytes=6_500_000_000, campaign=str(PLAN))

    def test_frozen_arguments_and_probe(self):
        self.assertEqual(campaign.validate_args(self.args, self.plan), (1024, [128, 256, 512, 1024]))
        for key, value in [('steps', 256), ('budget_bytes', 8 * 1024**3), ('allocator_cap_bytes', 7_000_000_000)]:
            args = copy.copy(self.args)
            setattr(args, key, value)
            with self.assertRaises(ValueError):
                campaign.validate_args(args, self.plan)
        self.args.mode = 'probe'
        with self.assertRaises(ValueError):
            campaign.validate_args(self.args, self.plan)
        self.args.steps = 1
        self.assertEqual(campaign.validate_args(self.args, self.plan), (1, [1]))

    def test_frozen_campaign_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'campaign.json'
            path.write_text(PLAN.read_text().replace('1024', '1025'))
            with self.assertRaises(ValueError):
                campaign.load_campaign(path)

    def test_nonfinite_loss_cannot_reach_optimizer(self):
        self.assertEqual(campaign.mean_loss([1, 2]), 1.5)
        for losses in [[], [float('nan')], [float('inf')], [1, -float('inf')]]:
            with self.assertRaises(ValueError):
                campaign.mean_loss(losses)

    def test_memory_boundaries(self):
        sample = {'peak_reserved_bytes': 6_500_000_000, 'cuda_free_delta_bytes': 7_499_999_999}
        campaign.validate_memory(sample, self.plan)
        for key, value in [('peak_reserved_bytes', 6_500_000_001), ('cuda_free_delta_bytes', 7_500_000_000)]:
            changed = {**sample, key: value}
            with self.assertRaises(ValueError):
                campaign.validate_memory(changed, self.plan)

    def test_saved_adapter_reload_requires_same_complete_finite_inventory(self):
        self.assertTrue(campaign.compare_reload({'a': 1.0}, {'a': 1.000001})['ok'])
        self.assertFalse(campaign.compare_reload({'a': 1.0}, {'a': 1.01})['ok'])
        for expected, actual in [({}, {}), ({'a': 1}, {'b': 1}), ({'a': 1}, {'a': float('nan')})]:
            with self.assertRaises(ValueError):
                campaign.compare_reload(expected, actual)

    def test_cancellation_records_failed_exit_and_no_checkpoint(self):
        fake_torch = SimpleNamespace(device=lambda _: 'cuda:0', cuda=SimpleNamespace(
            mem_get_info=lambda _: (_ for _ in ()).throw(InterruptedError('owned cancel'))))
        fake_safetensors = SimpleNamespace(save_file=lambda *args: None, load_file=lambda *args: {})
        with tempfile.TemporaryDirectory() as directory:
            self.args.output = str(Path(directory) / 'run')
            with patch.dict('sys.modules', {'torch': fake_torch, 'safetensors': SimpleNamespace(),
                                           'safetensors.torch': fake_safetensors}), patch.object(
                    campaign.objective, 'load_contract', return_value=([], [], {}, {})):
                with self.assertRaises(InterruptedError):
                    campaign.run(self.args)
            receipt = json.loads((Path(self.args.output) / 'exit.json').read_text())
            self.assertFalse(receipt['ok'])
            self.assertTrue(receipt['canceled'])
            self.assertEqual(receipt['steps_completed'], 0)
            self.assertFalse((Path(self.args.output) / 'checkpoints').exists())


if __name__ == '__main__':
    unittest.main()
