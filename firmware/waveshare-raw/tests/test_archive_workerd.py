"""Exercise the host uploader against the actual local workerd/D1/R2 interface."""
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from test_archive_uploader import ROOT, NODE, POLICY, TOKEN, cpraw, tool


class WorkerdTransport:
    def __init__(self):
        self.process = subprocess.Popen(['node', str(ROOT / 'tests/archive_workerd.mjs')],
            cwd=ROOT.parents[1], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        ready = self.process.stdout.readline()
        if ready != '{"ready":true}\n':
            self.close()
            raise AssertionError('local synthetic archive fixture failed to initialize')

    def request(self, method, url, body, headers):
        self.process.stdin.write(json.dumps({'method': method, 'url': url,
            'body': base64.b64encode(body).decode(), 'headers': headers}) + '\n')
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        if 'error' in response:
            raise AssertionError('local synthetic archive fixture failed')
        return tool.Reply(response['status'], response['headers'], base64.b64decode(response['body']))

    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ActualArchiveTests(unittest.TestCase):
    def test_real_http_transport_rejects_redirect_and_oversized_reply(self):
        visited = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                visited.append(self.path)
                self.send_response(307 if self.path == '/redirect' else 200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                if self.path == '/redirect':
                    self.send_header('Location', '/credential-leak')
                self.end_headers()
                self.wfile.write(b'{}' if self.path != '/oversized' else b'x' * (tool.MAX_REPLY_BYTES + 1))
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = tool.HttpTransport(timeout=2)
            base = f'http://127.0.0.1:{server.server_port}'
            reply = client.request('GET', base + '/redirect', b'', {'Authorization': 'Bearer ' + TOKEN})
            self.assertEqual(reply.status, 307)
            self.assertNotIn('/credential-leak', visited)
            with self.assertRaises(tool.ArchiveError):
                client.request('GET', base + '/oversized', b'', {})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_frozen_upload_retry_and_validation_in_workerd(self):
        transport = WorkerdTransport()
        try:
            with tempfile.TemporaryDirectory(prefix='cpraw-host-workerd-') as directory:
                root = Path(directory)
                original = root / 'synthetic.bin'
                sample = cpraw()
                crossing = sample[:32] + sample[32:] * 1000
                for data, status, reports in ((crossing, 'valid', 1000), (b'', 'invalid', None),
                                               (sample[:-1], 'interrupted_tail', 0)):
                    original.write_bytes(data)
                    upload_id = tool.prepare(original, root / 'spool', origin='https://synthetic.test',
                        node=NODE, policy=POLICY)
                    first = tool.upload(root / 'spool', upload_id, TOKEN, transport=transport)
                    second = tool.upload(root / 'spool', upload_id, TOKEN, transport=transport)
                    self.assertEqual(first, second)
                    self.assertEqual(first['validation']['status'], status)
                    self.assertEqual(first['validation']['reports'], reports)
                    self.assertEqual(original.read_bytes(), data)
                    self.assertEqual((root / 'spool' / upload_id / 'segment.bin').read_bytes(), data)
        finally:
            transport.close()


if __name__ == '__main__':
    unittest.main()
