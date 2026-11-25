"""Run with python3 -m unittest discover -s test -p autodl_worker_test.py."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'autodl'))
import models
import ranges
from progress import DownloadProgress
from acceptance import prepare_graph


class ModelInstallTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.content = bytes(range(251)) * 40
        self.spec = {'bytes': len(self.content), 'sha256': hashlib.sha256(self.content).hexdigest()}
        chunk = patch.object(ranges, 'CHUNK', 1024)
        chunk.start()
        self.addCleanup(chunk.stop)

    def server(self, bad=False):
        seen = []
        content = self.content
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if not self.headers['Range']:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(content)
                    return
                interval = self.headers['Range'][6:]
                start, end = map(int, interval.split('-'))
                seen.append(start)
                self.send_response(206)
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(content)}')
                self.end_headers()
                self.wfile.write((b'!' * (end-start+1)) if bad else content[start:end+1])
            def log_message(self, *args):
                pass
        class Server(ThreadingHTTPServer):
            request_queue_size = 64
        http = Server(('127.0.0.1', 0), Handler)
        threading.Thread(target=http.serve_forever, daemon=True).start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        return 'http://127.0.0.1:' + str(http.server_port), seen

    def test_resume_and_verify(self):
        url, seen = self.server()
        dest = self.root / 'weights.bin'
        part = self.root / 'weights.bin.part'
        part.write_bytes(self.content[:2048])
        self.spec['urls'] = [url]
        models.download(dest, self.spec, lambda _: None)
        self.assertNotIn(0, seen)
        self.assertNotIn(1024, seen)
        self.assertEqual(dest.read_bytes(), self.content)
        self.assertFalse(part.exists())

    def test_all_sources_down_waits_and_tries_again(self):
        url, _ = self.server()
        dest = self.root / 'weights.bin'
        self.spec['urls'] = [url]
        real, calls = ranges.transfer, []
        def flaky(*args):
            calls.append(1)
            if len(calls) == 1:
                raise OSError('该源未能提供完整分段：ReadTimeout')
            return real(*args)
        with patch.object(ranges, 'transfer', flaky), patch.object(models, 'PAUSES', (0.01,)):
            models.download(dest, self.spec, lambda _: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual(dest.read_bytes(), self.content)

    def test_small_file_waits_out_a_network_outage(self):
        url, _ = self.server()
        dest = self.root / 'preview.bin'
        self.spec['urls'] = ['http://127.0.0.1:9/unreachable']
        with patch.object(ranges, 'CHUNK', 1 << 30), patch.object(models, 'PAUSES', (0.01,)), \
                patch.object(models.time, 'sleep', lambda _: self.spec.update(urls=[url])):
            models.download(dest, self.spec, lambda _: None)
        self.assertEqual(dest.read_bytes(), self.content)

    def test_failed_sources_preserve_sparse_resume_map(self):
        part = self.root / 'model.part'
        part.write_bytes(self.content)
        ranges.journal(part).write_text(json.dumps({'sha256': self.spec['sha256'], 'chunks': [0, 2]}))
        with self.assertRaisesRegex(RuntimeError, '保留'):
            ranges.contiguous(part, self.spec)
        self.assertEqual(ranges.completed(part, self.spec), {0, 2})

    def test_fallback_after_corrupt_mirror(self):
        bad, _ = self.server(True)
        good, _ = self.server()
        self.spec['urls'] = [bad, good]
        dest = self.root / 'a.bin'
        models.download(dest, self.spec, lambda _: None)
        self.assertEqual(dest.read_bytes(), self.content)

    def test_disk_plan_counts_verified_and_partial_separately(self):
        external = self.root / 'other'
        external.mkdir()
        (external / 'b').write_bytes(self.content)
        dest = self.root / 'models'
        dest.mkdir()
        (dest / 'a.part').write_bytes(self.content[:128])
        needed, pending = models.plan(dest, {'a': self.spec, 'b': self.spec}, external, lambda _: None)
        self.assertEqual(needed, self.spec['bytes'] - 128)
        self.assertEqual(len(pending), 1)
        self.assertTrue((dest / 'b').is_symlink())
        with self.assertRaisesRegex(RuntimeError, '空间不足'):
            models.ensure_space(self.root, 10**18, 0)
        (dest / 'a').write_bytes(b'existing')
        with self.assertRaisesRegex(RuntimeError, '已有文件'):
            models.plan(dest, {'a': self.spec}, external, lambda _: None)
        self.assertEqual((dest / 'a').read_bytes(), b'existing')

    def test_progress_combines_cache_resumes_and_parallel_transfers(self):
        a, b = self.root / 'a', self.root / 'b'
        (self.root / 'a.part').write_bytes(b'x' * 10)
        specs = {name: {'bytes': 100} for name in ('a', 'b', 'cached')}
        with patch('progress.time.monotonic', return_value=100) as clock:
            meter = DownloadProgress(specs, [(a, specs['a']), (b, specs['b'])])
            self.assertEqual(meter.snapshot()['saved'], 110)
            clock.return_value = 110
            meter.record(a, 40)
            meter.record(b, 20)
            self.assertEqual(meter.snapshot()['saved'], 160)
            self.assertEqual(meter.snapshot()['rate'], 5)
            meter.record(b, 0)
            self.assertEqual(meter.snapshot()['rate'], 0)
            meter.record(a, 100)
            meter.record(b, 100)
            self.assertEqual(meter.snapshot()['saved'], 300)
            self.assertEqual(meter.snapshot()['total'], 300)

    def test_reference_and_card_specific_encoder(self):
        graph = {'1': {'inputs': {'clip_name': models.FP4, 'image': 'ref/bbt_acceptance.png [output]',
                                  'filename_prefix': 'video/bbt_acceptance'}}}
        out = prepare_graph(graph, {models.INT8: 'sub/' + models.INT8}, False, 'id', 'ref/generated.png')
        self.assertEqual(out['1']['inputs'], {'clip_name': 'sub/' + models.INT8, 'image': 'ref/generated.png [output]',
                                             'filename_prefix': 'video/bbt_acceptance_id'})
        self.assertEqual(graph['1']['inputs']['clip_name'], models.FP4)


try:
    import setup  # the worker locks with fcntl, so it only imports on Linux and macOS
except ImportError:
    setup = None


@unittest.skipIf(setup is None, 'the AutoDL worker needs fcntl')
class ModelsOnlyRunTest(unittest.TestCase):
    server = ModelInstallTest.server

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        self.root = base / 'blackbox' / '8188'
        self.root.mkdir(parents=True)
        bundle = base / 'bundle'
        (bundle / 'autodl').mkdir(parents=True)
        self.content = bytes(range(251)) * 40
        spec = {'bytes': len(self.content), 'sha256': hashlib.sha256(self.content).hexdigest()}
        url, _ = self.server()
        files = {name: {**spec, 'urls': [url]} for name in
                 ('text_encoders/' + models.INT8, 'text_encoders/' + models.FP4, 'vae/v.safetensors')}
        catalog = {'files': files, 'workflows': {'wf': ['text_encoders/' + models.FP4, 'vae/v.safetensors']}}
        (bundle / 'autodl/models.json').write_text(json.dumps(catalog))
        self.bundle = bundle
        self.catalog = catalog
        for patcher in (patch.object(setup, 'BUNDLE', bundle), patch.object(ranges, 'CHUNK', 1024),
                        patch.object(setup, 'ensure_space', lambda *_: None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_setup(self, **extra):
        (self.bundle / 'recipe.json').write_text(json.dumps({'workflows': ['wf'], 'plugins': [], 'nodes': [], **extra}))
        state = {'run': 'r'}
        setup.execute(self.root, 8188, state)
        return state

    def test_gpu_less_boot_downloads_int8_and_stops_before_the_gpu_stages(self):
        with patch.object(setup.subprocess, 'check_output', side_effect=FileNotFoundError) as smi, \
             patch.object(setup, 'install_core', side_effect=AssertionError('no runtime install')):
            state = self.run_setup(modelsOnly=True)
        smi.assert_not_called()
        self.assertEqual(state['status'], 'downloaded')
        self.assertTrue(state['modelsOnly'])
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['status'], 'downloaded')
        staged = self.root / 'models' / 'text_encoders'
        self.assertEqual((staged / models.INT8).read_bytes(), self.content)
        self.assertFalse((staged / models.FP4).exists())
        self.assertFalse((self.root / 'ComfyUI').exists())

        # The later paid GPU run keeps the INT8 encoder and trusts the recorded verification.
        self.assertFalse(models.prefer_fp4(self.root / 'models', True))
        files = models.inventory(self.catalog, ['wf'], False)
        with patch.object(models, 'digest', side_effect=AssertionError('rehashed a verified file')):
            needed, pending = models.plan(self.root / 'models', files, self.root / 'none', lambda _: None)
        self.assertEqual((needed, pending), (0, []))

    def test_changed_file_is_hashed_again(self):
        dest = self.root / 'x.bin'
        dest.write_bytes(self.content)
        spec = {'bytes': len(self.content), 'sha256': hashlib.sha256(self.content).hexdigest()}
        self.assertTrue(models.known_good(dest, spec))
        dest.write_bytes(b'!' * len(self.content))
        self.assertFalse(models.known_good(dest, spec))

    def test_encoder_choice_without_a_staged_download(self):
        self.assertTrue(models.prefer_fp4(self.root / 'models', True))
        self.assertFalse(models.prefer_fp4(self.root / 'models', False))

    def test_full_run_without_gpu_explains_the_gpu_less_option(self):
        with patch.object(setup.subprocess, 'check_output', side_effect=FileNotFoundError):
            with self.assertRaisesRegex(RuntimeError, '无卡模式'):
                self.run_setup()


@unittest.skipIf(setup is None, 'the AutoDL worker needs fcntl')
class PipRetryTest(unittest.TestCase):
    def test_pip_goes_round_again_after_a_mirror_timeout(self):
        calls = []
        def flaky(args):
            calls.append(args)
            if len(calls) < 3:
                raise setup.subprocess.CalledProcessError(2, args)
        with patch.object(setup, 'run', flaky), patch.object(setup, 'PIP_PAUSES', (0, 0, 0)):
            setup.pip_install(['py', '-m', 'pip', 'install', '-r', 'req.txt'])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][:8], ['py', '-m', 'pip', 'install', '--timeout', '60', '--retries', '10'])

    def test_pip_gives_up_after_the_last_round(self):
        def down(args):
            raise setup.subprocess.CalledProcessError(2, args)
        with patch.object(setup, 'run', down), patch.object(setup, 'PIP_PAUSES', (0,)):
            with self.assertRaises(setup.subprocess.CalledProcessError):
                setup.pip_install(['py', '-m', 'pip', 'install', 'x'])


@unittest.skipIf(setup is None, 'the AutoDL worker needs fcntl')
class InstallActivityTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)

    def test_reads_what_pip_is_fetching(self):
        log = self.root / 'setup.log'
        log.write_text('Collecting einops\n  Downloading http://mirrors.aliyun.com/pypi/packages/c2/be/x/'
                       'opencv_python_headless-5.1.0.95-cp37-abi3-manylinux_2_28_x86_64.whl (63.7 MB)\n'
                       '     ━━━━━ 12.0/63.7 MB 494.0 kB/s eta 0:01:44\n')
        self.assertEqual(setup.log_activity(log), ('下载 Python 依赖', 'opencv_python_headless（63.7 MB）'))
        log.write_text('Installing collected packages: einops, av\n')
        self.assertEqual(setup.log_activity(log)[0], '安装 Python 依赖包')
        self.assertEqual(setup.log_activity(self.root / 'missing.log'), ('安装运行环境', ''))

    def test_template_gallery_is_left_out(self):
        core = self.root / 'ComfyUI'
        core.mkdir()
        (core / 'requirements.txt').write_text('comfyui-frontend-package==1.52.7\ncomfyui-workflow-templates==0.11.66\ntorch\n')
        out = setup.core_requirements(core, self.root / 'req.txt').read_text()
        self.assertNotIn('workflow-templates', out)
        self.assertIn('comfyui-frontend-package', out)

    def test_heartbeat_reports_bytes_and_clears_when_done(self):
        import threading
        state, lock = {'status': 'running'}, threading.Lock()
        (self.root / 'setup.log').write_text('Collecting av\n')
        with setup.Heartbeat(self.root, state, lock, interval=0.05):
            (self.root / 'pip-cache').mkdir()
            (self.root / 'pip-cache' / 'a.whl').write_bytes(b'x' * 4096)
            time.sleep(0.3)
            seen = json.loads((self.root / 'state.json').read_text())['activity']
        self.assertEqual(seen['bytes'], 4096)
        self.assertEqual(seen['detail'], 'av')
        self.assertNotIn('activity', state)
