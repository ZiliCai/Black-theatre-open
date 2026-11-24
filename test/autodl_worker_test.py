"""Run with python3 -m unittest discover -s test -p autodl_worker_test.py."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'autodl'))
import models
import ranges
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

    def test_reference_and_card_specific_encoder(self):
        graph = {'1': {'inputs': {'clip_name': models.FP4, 'image': 'ref/bbt_acceptance.png [output]',
                                  'filename_prefix': 'video/bbt_acceptance'}}}
        out = prepare_graph(graph, {models.INT8: 'sub/' + models.INT8}, False, 'id', 'ref/generated.png')
        self.assertEqual(out['1']['inputs'], {'clip_name': 'sub/' + models.INT8, 'image': 'ref/generated.png [output]',
                                             'filename_prefix': 'video/bbt_acceptance_id'})
        self.assertEqual(graph['1']['inputs']['clip_name'], models.FP4)
