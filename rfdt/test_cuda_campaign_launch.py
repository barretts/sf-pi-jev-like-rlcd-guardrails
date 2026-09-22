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
        for name in ('cuda_campaign.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py', 'gemma3_fp32.py'):
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
            hashes = {name: '0' * 64 for name in ['cuda_campaign.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py', 'gemma3_fp32.py']}
            source = code / 'source'
            source.write_text('code')
            (code / 'cuda_campaign.py').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'regular'):
                launch.verify_code(code, hashes)


    def snapshot_fixture(self, root):
        checkpoint = root / 'run/checkpoints/step-128'
        checkpoint.mkdir(parents=True)
        receipt = {'checkpoint_step': 128, 'source': {'source_sha256': 'a' * 64}}
        (checkpoint / 'receipt.json').write_text(json.dumps(receipt))
        (checkpoint / 'exit.json').write_text(json.dumps({'ok': True, 'steps_completed': 128, 'completed_time_unix': 15}))
        launch_record = {'launcher_sha256': launch.digest(Path(launch.__file__)),
                         'watchdog_sha256': launch.digest(Path(launch.monitor.__file__)),
                         'monitor_sha256': launch.digest(Path(launch.monitor.__file__)),
                         'worker_pid': 123, 'worker_sha256': 'a' * 64,
                         'baseline_dedicated_bytes': 7_000_000_000, 'baseline_shared_bytes': 30,
                         'hard_budget_bytes': 8_000_000_000, 'stop_dedicated_delta_bytes': 7_500_000_000,
                         'shared_growth_limit_bytes': 128_000_000, 'stop_total_dedicated_bytes': 16_000_000_000}
        (root / 'launch.json').write_text(json.dumps(launch_record))
        rows = [{'time_unix': t, 'elapsed_seconds': t - 5, 'dedicated_bytes': 9_000_000_000,
                 'shared_bytes': 40, 'dedicated_delta_bytes': 2_000_000_000, 'shared_delta_bytes': 10}
                for t in [10, 20]]
        prefix = ''.join(json.dumps(row) + '\n' for row in rows).encode()
        (root / 'memory.jsonl').write_bytes(prefix + b'{"partial":')
        return checkpoint, rows, prefix

    def test_snapshot_copies_complete_immutable_prefix_and_binds_producer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, rows, prefix = self.snapshot_fixture(root)
            snapshot = launch.snapshot_checkpoint_memory(root, 128)
            output = root / 'checkpoint-snapshots/step-128'
            self.assertEqual((output / 'memory.jsonl').read_bytes(), prefix)
            summary = json.loads((output / 'memory.summary.json').read_text())
            self.assertEqual(summary['reason'], 'checkpoint_snapshot')
            self.assertEqual(summary['peak_total_dedicated_bytes'], 9_000_000_000)
            self.assertEqual(summary['peak_dedicated_delta_bytes'], 2_000_000_000)
            self.assertEqual(summary['samples'], 2)
            self.assertEqual(snapshot['producer_sha256'], launch.digest(Path(launch.__file__)))
            self.assertEqual(snapshot['checkpoint_receipt_sha256'], launch.digest(checkpoint / 'receipt.json'))
            (root / 'memory.jsonl').write_text('changed source')
            self.assertEqual((output / 'memory.jsonl').read_bytes(), prefix)
            with self.assertRaisesRegex(ValueError, 'already exists'):
                launch.snapshot_checkpoint_memory(root, 128)

    def test_snapshot_rejects_unfinished_stale_overbudget_or_tampered_source(self):
        for defect in ['unfinished', 'stale', 'budget', 'deltas', 'producer', 'monitor', 'worker', 'ordering', 'error']:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkpoint, rows, _ = self.snapshot_fixture(root)
                if defect in ['unfinished', 'stale']:
                    (checkpoint / 'exit.json').write_text(json.dumps({'ok': defect != 'unfinished', 'steps_completed': 128,
                                                                     'completed_time_unix': 25}))
                elif defect in ['budget', 'deltas', 'ordering', 'error']:
                    if defect == 'budget':
                        rows[-1]['dedicated_bytes'] = 16_000_000_000
                        rows[-1]['dedicated_delta_bytes'] = 9_000_000_000
                    elif defect == 'deltas':
                        rows[-1]['dedicated_delta_bytes'] = 0
                    elif defect == 'ordering':
                        rows[-1]['time_unix'] = rows[0]['time_unix']
                    else:
                        rows[-1] = {'monitor_error': 'counter missing'}
                    (root / 'memory.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
                else:
                    data = json.loads((root / 'launch.json').read_text())
                    data[{'producer': 'launcher_sha256', 'monitor': 'monitor_sha256', 'worker': 'worker_sha256'}[defect]] = 'b' * 64
                    (root / 'launch.json').write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    launch.snapshot_checkpoint_memory(root, 128)
                self.assertFalse((root / 'checkpoint-snapshots/step-128').exists())


if __name__ == '__main__':
    unittest.main()
