"""No-GPU launch tests: immutable code, fresh paths, and exact bounded commands."""
import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

import cuda_campaign_launch as launch


class LaunchTests(unittest.TestCase):
    def prepare(self, root):
        inputs = root / 'inputs'
        code = inputs / 'code'
        code.mkdir(parents=True)
        hashes = {}
        for name in ('cuda_campaign.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py'):
            (code / name).write_text('# frozen ' + name)
            hashes[name] = launch.digest(code / name)
        fixture = Path(__file__).resolve().parents[1] / 'fixtures/guardrail/candidate10/cuda-campaign.json'
        (code / 'cuda-campaign.json').write_bytes(fixture.read_bytes())
        return argparse.Namespace(inputs=str(inputs), run_root=str(root / 'run'),
                                  adapter_tag='pinned', mode='train', code_sha256_json=json.dumps(hashes))

    def test_hash_tampering_rejects_before_monitor_or_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self.prepare(root)
            (root / 'inputs/code/worker.py').write_text('tampered')
            with patch.object(launch.monitor, 'sample') as sample, patch.object(launch.subprocess, 'Popen') as process:
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    launch.run(args)
            sample.assert_not_called()
            process.assert_not_called()
            self.assertFalse(Path(args.run_root).exists())

    def test_train_and_probe_launch_exact_owned_watchdog_with_total_cap(self):
        for mode, steps in [('train', '1024'), ('probe', '1')]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                args.mode = mode
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(7_000_000_000, 30)
                ), patch.object(launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]) as process:
                    receipt = launch.run(args)
                command = receipt['worker_command']
                self.assertEqual(command[command.index('--steps') + 1], steps)
                self.assertEqual(command[command.index('--allocator-cap-bytes') + 1], '6500000000')
                watchdog = receipt['watchdog_command']
                self.assertEqual(watchdog[watchdog.index('--stop-total-dedicated-bytes') + 1], '16000000000')
                self.assertEqual(watchdog[watchdog.index('--worker') + 1], command[1])
                self.assertEqual(receipt['campaign_sha256'], launch.cuda_campaign.CAMPAIGN_SHA256)
                self.assertEqual(receipt['stop_total_dedicated_bytes'], 16_000_000_000)
                self.assertEqual(receipt['worker_pid'], 102)
                self.assertTrue(all(call.kwargs['stdin'] == launch.subprocess.DEVNULL for call in process.call_args_list))

    def test_existing_root_and_total_usage_reject_without_spawn(self):
        for existing in [False, True]:
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                if existing:
                    Path(args.run_root).mkdir()
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(16_000_000_000, 0)
                ), patch.object(launch.subprocess, 'Popen') as process:
                    with self.assertRaises(ValueError):
                        launch.run(args)
                process.assert_not_called()

    def test_code_inventory_and_symlink_reject(self):
        with tempfile.TemporaryDirectory() as temporary:
            code = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'exactly'):
                launch.verify_code(code, {})
            hashes = {name: '0' * 64 for name in ['cuda_campaign.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py']}
            source = code / 'source'
            source.write_text('code')
            (code / 'cuda_campaign.py').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'regular'):
                launch.verify_code(code, hashes)


if __name__ == '__main__':
    unittest.main()
