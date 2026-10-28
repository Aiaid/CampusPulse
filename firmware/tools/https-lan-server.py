#!/usr/bin/env -S uv run --script
"""Synthetic LAN HTTPS benchmark; no production ingest or cloud ACK support.

Run with uv run firmware/tools/https-lan-server.py --cert CERT --key KEY.
Certificates must be generated separately and trusted explicitly by the client.
Only content-free metrics are saved; request digests are returned, never logged.
"""

import argparse
import hashlib
import json
import socket
import ssl
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 16384
SOCKET_TIMEOUT = 10
MAX_CONNECTIONS = 16


class Metrics:
    def __init__(self, output_dir):
        output_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        self.file = (output_dir / f"https-lan-{stamp}.jsonl").open("x", encoding="utf-8")
        self.lock = threading.Lock()
        self.origin = time.monotonic()
        self.connections = 0
        self.requests = 0

    def milliseconds(self):
        return round((time.monotonic() - self.origin) * 1000, 3)

    def next_connection(self):
        with self.lock:
            self.connections += 1
            return self.connections

    def next_request(self):
        with self.lock:
            self.requests += 1
            return self.requests

    def emit(self, event, **fields):
        line = json.dumps({"event": event, "elapsed_ms": self.milliseconds(), **fields}, separators=(",", ":"))
        with self.lock:
            self.file.write(line + "\n")
            self.file.flush()

    def close(self):
        self.emit("summary", connections=self.connections, requests=self.requests)
        self.file.close()


class BenchmarkHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LanBenchmark/1"
    sys_version = ""

    def log_message(self, *args):
        # BaseHTTPRequestHandler logs client addresses and request text by default.
        pass

    def handle_one_request(self):
        self.started = time.monotonic()
        self.received = 0
        self.route = "unknown"
        super().handle_one_request()

    def send_error(self, code, message=None, explain=None):
        # Never reflect request lines, paths, header contents or parser messages.
        self.respond(code, {"ok": False, "error": "invalid_request"}, close=True)

    def handle_expect_100(self):
        self.respond(417, {"ok": False, "error": "expect_not_supported"}, close=True)
        return False

    def respond(self, status, document, close=False):
        payload = json.dumps(document, separators=(",", ":")).encode("ascii")
        if close:
            self.close_connection = True
        written = False
        try:
            # Malformed request lines can leave request_version unset/HTTP/0.9.
            # Always send a framed HTTP/1.1 error, including for those inputs.
            self.request_version = "HTTP/1.1"
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
            written = True
        except (OSError, ValueError):
            self.close_connection = True
        finally:
            self.server.metrics.emit(
                "request", connection=self.connection_id,
                request=self.server.metrics.next_request(), route=self.route,
                status=status, received_bytes=self.received,
                response_bytes=len(payload) if written else 0, response_written=written,
                duration_ms=round((time.monotonic() - self.started) * 1000, 3),
            )

    def content_length(self, required=False):
        if self.request_version != "HTTP/1.1":
            self.respond(505, {"ok": False, "error": "http_1_1_required"}, close=True)
            return None
        if self.headers.get_all("Transfer-Encoding") or self.headers.get_all("Expect"):
            self.respond(400, {"ok": False, "error": "unsupported_framing"}, close=True)
            return None
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths and not required:
            return 0
        if not lengths:
            self.respond(411, {"ok": False, "error": "length_required"}, close=True)
            return None
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit() or len(lengths[0]) > 8:
            self.respond(400, {"ok": False, "error": "invalid_length"}, close=True)
            return None
        length = int(lengths[0])
        if length > MAX_BODY:
            self.respond(413, {"ok": False, "error": "body_too_large"}, close=True)
            return None
        return length

    def do_GET(self):
        self.route = "health" if self.path == "/health" else "unknown"
        length = self.content_length()
        if length is None:
            return
        if length:
            self.respond(400, {"ok": False, "error": "get_body_not_supported"}, close=True)
        elif self.route == "health":
            self.respond(200, {"ok": True, "benchmark": "lan-https", "tls": "TLSv1.2"})
        else:
            self.respond(404, {"ok": False, "error": "unknown_endpoint"}, close=True)

    def do_POST(self):
        self.route = "benchmark" if self.path == "/benchmark" else "unknown"
        length = self.content_length(required=True)
        if length is None:
            return
        if self.route != "benchmark":
            self.respond(404, {"ok": False, "error": "unknown_endpoint"}, close=True)
            return
        try:
            body = self.rfile.read(length)
        except (OSError, ValueError):
            self.respond(408, {"ok": False, "error": "body_timeout"}, close=True)
            return
        self.received = len(body)
        if len(body) != length:
            self.respond(400, {"ok": False, "error": "incomplete_body"}, close=True)
            return
        self.respond(200, {"ok": True, "received": length, "sha256": hashlib.sha256(body).hexdigest()})


class BenchmarkServer(ThreadingHTTPServer):
    # Wait for bounded workers before closing metrics at shutdown.
    daemon_threads = False
    block_on_close = True

    def __init__(self, bind, context, metrics):
        self.context = context
        self.metrics = metrics
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(bind, BenchmarkHandler)

    def process_request(self, request, client_address):
        connection = self.metrics.next_connection()
        accepted_ms = self.metrics.milliseconds()
        self.metrics.emit("connection_accepted", connection=connection)
        if not self.slots.acquire(blocking=False):
            self.metrics.emit("connection_rejected", connection=connection, reason="capacity")
            self.shutdown_request(request)
            return
        try:
            # The worker only needs an opaque ID and acceptance time, never the peer.
            super().process_request(request, (connection, accepted_ms))
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        connection, accepted_ms = client_address
        tls_socket = None
        handshake_complete = False
        started = time.monotonic()
        self.metrics.emit("handshake_start", connection=connection, accepted_ms=accepted_ms)
        try:
            request.settimeout(SOCKET_TIMEOUT)
            # Small JSON replies must not wait for Nagle/delayed-ACK interaction.
            # Set this on the accepted TCP socket before ownership moves to TLS.
            request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # TLS is negotiated in this worker, so stalled handshakes never block accept.
            tls_socket = self.context.wrap_socket(request, server_side=True, do_handshake_on_connect=False)
            tls_socket.do_handshake()
            handshake_complete = True
            self.metrics.emit("handshake_finish", connection=connection, ok=True,
                              duration_ms=round((time.monotonic() - started) * 1000, 3),
                              tls=tls_socket.version(), session_reused=tls_socket.session_reused)
            # Pass only a synthetic address to the HTTP layer; it never needs the peer.
            handler_type = self.RequestHandlerClass
            class ConnectedHandler(handler_type):
                connection_id = connection
            ConnectedHandler(tls_socket, ("", 0), self)
        except (ssl.SSLError, OSError, ValueError):
            if not handshake_complete:
                self.metrics.emit("handshake_finish", connection=connection, ok=False,
                                  duration_ms=round((time.monotonic() - started) * 1000, 3))
            self.metrics.emit("connection_failure", connection=connection,
                              duration_ms=round((time.monotonic() - started) * 1000, 3))
        except Exception:
            self.metrics.emit("server_error", connection=connection)
        finally:
            self.shutdown_request(tls_socket if tls_socket is not None else request)
            self.metrics.emit("connection_closed", connection=connection)
            self.slots.release()

    def handle_error(self, request, client_address):
        # Never emit tracebacks containing peer addresses or request information.
        self.metrics.emit("server_error")


def tls_context(cert, key):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.maximum_version = ssl.TLSVersion.TLSv1_2
    context.set_alpn_protocols(["http/1.1"])
    context.load_cert_chain(cert, key)
    return context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0", help="listen interface (default: all IPv4 interfaces)")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--cert", required=True, type=Path)
    parser.add_argument("--key", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("captures/https-lan"), help="content-free JSONL metrics directory; keep it git-ignored")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    metrics = None
    server = None
    try:
        context = tls_context(args.cert, args.key)
        metrics = Metrics(args.output_dir)
        server = BenchmarkServer((args.bind, args.port), context, metrics)
        metrics.emit("start", tls="TLSv1.2", max_body_bytes=MAX_BODY, tcp_nodelay=True)
        print(f"LAN HTTPS benchmark ready on port {args.port}; TLS 1.2; synthetic data only.", flush=True)
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("Stopping LAN HTTPS benchmark.", flush=True)
    except (OSError, ssl.SSLError):
        # Paths and OS errors can contain personal information; keep the log generic.
        parser.exit(1, "Unable to initialize or run LAN HTTPS benchmark; check certificate, key, output directory and listen port.\n")
    finally:
        if server is not None:
            server.server_close()
        if metrics is not None:
            metrics.close()


if __name__ == "__main__":
    main()
