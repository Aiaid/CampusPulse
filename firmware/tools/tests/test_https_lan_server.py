"""Host framing/privacy checks using socketpairs; no listening port or TLS assets."""

import hashlib
import importlib.util
import json
import socket
import ssl
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("https_lan_server", Path(__file__).parents[1] / "https-lan-server.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HandlerChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.metrics = MODULE.Metrics(Path(self.directory.name))
        self.client, self.peer = socket.socketpair()
        self.client.settimeout(2)
        self.peer.settimeout(2)
        self.stream = self.client.makefile("rb")
        class Handler(MODULE.BenchmarkHandler):
            connection_id = 1
        self.worker = threading.Thread(target=Handler, args=(self.peer, ("", 0), SimpleNamespace(metrics=self.metrics)))
        self.worker.start()

    def tearDown(self):
        self.stream.close()
        self.client.close()
        self.worker.join(3)
        self.peer.close()
        self.assertFalse(self.worker.is_alive())
        self.metrics.close()
        self.directory.cleanup()

    def response(self):
        status = self.stream.readline().decode("ascii").strip()
        headers = {}
        while line := self.stream.readline():
            if line == b"\r\n":
                break
            key, value = line.decode("ascii").split(":", 1)
            headers[key.lower()] = value.strip()
        body = self.stream.read(int(headers["content-length"]))
        return int(status.split()[1]), headers, json.loads(body)

    def request(self, data):
        self.client.sendall(data)
        return self.response()

    def test_keepalive_and_exact_binary_digest(self):
        payload = bytes(range(256)) * 64
        status, headers, result = self.request(b"POST /benchmark HTTP/1.1\r\nHost: synthetic\r\nContent-Length: 16384\r\n\r\n" + payload)
        self.assertEqual(status, 200)
        self.assertEqual(result, {"ok": True, "received": 16384, "sha256": hashlib.sha256(payload).hexdigest()})
        self.assertNotIn("connection", headers)
        status, _, result = self.request(b"GET /health HTTP/1.1\r\nHost: synthetic\r\nConnection: close\r\n\r\n")
        self.assertEqual(status, 200)
        self.assertEqual(result["tls"], "TLSv1.2")

    def test_pipelined_requests_remain_separately_framed(self):
        self.client.sendall(b"POST /benchmark HTTP/1.1\r\nContent-Length: 0\r\n\r\nGET /health HTTP/1.1\r\nConnection: close\r\n\r\n")
        self.assertEqual(self.response()[2]["received"], 0)
        self.assertEqual(self.response()[2]["benchmark"], "lan-https")

    def test_duplicate_lengths_close_without_reading_body(self):
        status, headers, _ = self.request(b"POST /benchmark HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n")
        self.assertEqual(status, 400)
        self.assertEqual(headers["connection"], "close")

    def test_chunked_framing_rejected(self):
        status, _, _ = self.request(b"POST /benchmark HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n")
        self.assertEqual(status, 400)

    def test_oversize_rejected_before_body(self):
        status, _, _ = self.request(b"POST /benchmark HTTP/1.1\r\nContent-Length: 16385\r\n\r\n")
        self.assertEqual(status, 413)

    def test_missing_length_rejected(self):
        self.assertEqual(self.request(b"POST /benchmark HTTP/1.1\r\n\r\n")[0], 411)

    def test_short_body_never_gets_success(self):
        self.client.sendall(b"POST /benchmark HTTP/1.1\r\nContent-Length: 3\r\n\r\nx")
        self.client.shutdown(socket.SHUT_WR)
        status, _, result = self.response()
        self.assertEqual(status, 400)
        self.assertFalse(result["ok"])

    def test_unknown_route_and_headers_do_not_leak(self):
        sentinel = "private-sentinel-987654"
        status, _, result = self.request(f"POST /{sentinel} HTTP/1.1\r\nContent-Length: 0\r\nAuthorization: {sentinel}\r\n\r\n".encode())
        self.assertEqual(status, 404)
        self.assertNotIn(sentinel, json.dumps(result))
        self.worker.join(2)
        saved = next(Path(self.directory.name).glob("*.jsonl")).read_text()
        self.assertNotIn(sentinel, saved)
        self.assertNotIn("sha256", saved)
        events = [json.loads(line) for line in saved.splitlines()]
        self.assertEqual(events[0]["route"], "unknown")

    def test_malformed_request_line_gets_bounded_json_error(self):
        status, headers, result = self.request(b"INVALID\r\n\r\n")
        self.assertEqual(status, 400)
        self.assertEqual(headers["connection"], "close")
        self.assertEqual(result, {"ok": False, "error": "invalid_request"})


class TLSChecks(unittest.TestCase):
    def test_tls12_is_forced_without_loading_a_certificate(self):
        with patch.object(ssl.SSLContext, "load_cert_chain") as load:
            context = MODULE.tls_context(Path("synthetic-cert.pem"), Path("synthetic-key.pem"))
        self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertEqual(context.maximum_version, ssl.TLSVersion.TLSv1_2)
        load.assert_called_once()

    def test_stalled_tls_setup_runs_in_worker_and_is_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            metrics = MODULE.Metrics(Path(directory))
            entered = threading.Event()
            release = threading.Event()
            client, peer = socket.socketpair()
            request = Mock(wraps=peer)
            # AF_UNIX socketpairs have no TCP options; assert the real worker's
            # configuration call through a spy while retaining real close behavior.
            request.setsockopt = Mock()
            def stalled_wrap(*args, **kwargs):
                request.setsockopt.assert_called_once_with(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                entered.set()
                release.wait(2)
                raise ssl.SSLError("synthetic failure")
            # Construct only the dispatch object, with no bind or listening socket.
            server = MODULE.BenchmarkServer.__new__(MODULE.BenchmarkServer)
            server.metrics = metrics
            server.context = SimpleNamespace(wrap_socket=stalled_wrap)
            server.slots = threading.BoundedSemaphore(1)
            try:
                server.process_request(request, ("private-peer-sentinel", 12345))
                self.assertTrue(entered.wait(1))
                request.setsockopt.assert_called_once_with(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                # This line is reached while TLS setup is still waiting in its worker.
                self.assertFalse(server.slots.acquire(blocking=False))
            finally:
                release.set()
                server._threads.join()
                client.close()
                peer.close()
                metrics.close()
            saved = next(Path(directory).glob("*.jsonl")).read_text()
            self.assertNotIn("private-peer-sentinel", saved)
            events = [json.loads(line) for line in saved.splitlines()]
            finished = next(event for event in events if event["event"] == "handshake_finish")
            self.assertFalse(finished["ok"])
            self.assertEqual(events[-1]["connections"], 1)


if __name__ == "__main__":
    unittest.main()
