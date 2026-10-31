"""Synthetic host tests only. No serial device or network connection is opened."""
import contextlib
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import unittest
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

SPEC = importlib.util.spec_from_file_location("host_bootstrap", Path(__file__).resolve().parents[1] / "tools/host_bootstrap.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)
NODE = "cp_001122334455"
BOOT = "01234567-89ab-4cde-8123-456789abcdef"
NONCE = "0123456789abcdef0123456789abcdef"
WALL = 1793318400000
SECRET = "synthetic-credential-do-not-print-0001"


def certificate(ca=True):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic host CA")])
    now = datetime.datetime.now(datetime.UTC)
    return (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
            .sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode("ascii"))


def hello(nonce=NONCE):
    return dict(node_id=NODE, boot_id=BOOT, request_id=nonce, mono_ms=1234)


class Clock:
    def __init__(self):
        self.now = 10000
        self.wall_offset = 0

    def wall_ms(self):
        return WALL + self.now + self.wall_offset

    def mono_ms(self):
        return self.now


class Serial:
    def __init__(self, clock, **kwargs):
        self.clock, self.kwargs = clock, kwargs
        self.dtr = self.rts = True
        self.port = None
        self.opened = self.closed = False
        self.rx = bytearray()
        self.pending = bytearray()
        self.records = []
        self.frame_ref = None
        self.reply = lambda nonce: b"V3 HELLO " + json.dumps(hello(nonce)).encode() + b"\n"
        self.ack = b"V3 START ACCEPTED\n"
        self.max_write = 100000
        self.failure = None
        self.resets = 0

    def open(self):
        assert self.dtr is False and self.rts is False
        assert self.kwargs["port"] is None
        assert self.kwargs["timeout"] == 0.1 and self.kwargs["write_timeout"] == 1
        assert self.port == "fake-port"
        if self.failure == "open":
            raise OSError(SECRET)
        self.opened = True

    def close(self):
        self.closed = True

    def reset_input_buffer(self):
        self.resets += 1
        self.rx.clear()

    def write(self, data):
        if self.failure == "write":
            raise OSError(SECRET)
        if self.max_write == 0:
            return 0
        part = bytes(data[:self.max_write])
        if part.startswith(b"V3START "):
            self.frame_ref = data.obj
        self.pending.extend(part)
        if b"\n" in self.pending:
            line, rest = self.pending.split(b"\n", 1)
            self.pending = bytearray(rest)
            self.records.append(bytes(line))
            if line.startswith(b"HELLO "):
                self.rx.extend(self.reply(line[6:].decode()))
            else:
                self.rx.extend(self.ack)
        return len(part)

    def read(self, count):
        if self.failure == "read":
            raise OSError(SECRET)
        self.clock.now += 1 if self.rx else 100
        if not self.rx:
            return b""
        out = bytes(self.rx[:count])
        del self.rx[:count]
        return out


class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ca = certificate()
        cls.leaf = certificate(False)

    def setUp(self):
        for operation in ("socket", "create_connection", "getaddrinfo"):
            patcher = mock.patch.object(socket, operation, side_effect=AssertionError("network forbidden"))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.backend = dict(endpoint="https://192.168.23.9:8443", device_bearer=SECRET,
                            node_id=NODE, server_ca_pem=self.ca,
                            server_ca_file="/must/not/be/read", isolation="isolated-controlled-test")
        self.wifi = dict(ssid="synthetic-wifi", password="wifi-secret-do-not-print")
        self.public_backend = dict(endpoint="https://trial.example.org:8443", device_bearer=SECRET,
                                   node_id=NODE, tls="public_ca_bundle", isolation="isolated-controlled-test")

    def frame(self, **kwargs):
        values = dict(backend=self.backend, wifi=self.wifi, hello=hello(), request_id=NONCE,
                      sent_wall_ms=WALL, sent_mono_ms=10000,
                      received_wall_ms=WALL + 100, received_mono_ms=10100)
        values.update(kwargs)
        return host.build_frame(**values)

    def session(self, configure=None, **kwargs):
        clock = Clock()
        port = Serial(clock, port=None, timeout=.1, write_timeout=1, baudrate=115200)
        if configure:
            configure(port)
        def factory(**options):
            self.assertEqual(options, port.kwargs)
            return port
        kwargs.setdefault("nonce_factory", lambda: NONCE)
        try:
            host.run_bootstrap(kwargs.pop("backend", self.backend), self.wifi, "fake-port",
                               serial_factory=factory, clock=clock, **kwargs)
        finally:
            self.last_port = port
        return port

    def test_legal_frame_and_anchor(self):
        frame = self.frame(windows=3)
        self.assertLessEqual(len(frame) - 1, 8191)
        self.assertTrue(frame.isascii())
        self.assertEqual(frame.count(b"\n"), 1)
        value = json.loads(frame[8:])
        self.assertEqual(value["node_id"], NODE)
        self.assertEqual(value["boot_id"], BOOT)
        self.assertEqual(value["server_ca_pem"], self.ca)
        self.assertEqual(value["utc_ms"], WALL + 50)
        self.assertEqual(value["uncertainty_ms"], 301)
        self.assertEqual(value["anchor_mono_ms"], 1234)
        self.assertEqual(value["max_windows"], 3)
        self.assertNotIn("server_ca_file", value)
        self.assertEqual(set(value), {"node_id", "boot_id", "origin", "device_token", "ssid", "password", "security", "utc_ms", "uncertainty_ms", "anchor_mono_ms", "max_windows", "server_ca_pem"})

    def test_wrong_identity_boot_nonce_and_types(self):
        bad = [dict(node_id="cp_ffeeddccbbaa"), dict(boot_id="01234567-89ab-1cde-8123-456789abcdef"),
               dict(boot_id=7), dict(request_id="a" * 32), dict(mono_ms=True),
               dict(mono_ms=-1), dict(mono_ms=9007199254740992), dict(extra="hidden")]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(host.BootstrapError):
                self.frame(hello=hello() | change)
        for windows in (0, 4, True, 1.0):
            with self.assertRaises(host.BootstrapError):
                self.frame(windows=windows)

    def test_bounded_time_and_wall_jump(self):
        for arguments in (dict(received_mono_ms=9999), dict(received_mono_ms=12001, received_wall_ms=WALL+2001),
                          dict(received_wall_ms=WALL+121), dict(sent_wall_ms=1),
                          dict(received_wall_ms=True), dict(sent_mono_ms=-1)):
            with self.subTest(arguments=arguments), self.assertRaises(host.BootstrapError):
                self.frame(**arguments)
        value = json.loads(self.frame(received_mono_ms=12000, received_wall_ms=WALL+2000)[8:])
        self.assertEqual(value["uncertainty_ms"], 1251)

    def test_only_rfc1918_https_ipv4_origins(self):
        for endpoint in ("http://192.168.1.2", "https://pulse.anend.net", "https://pulse.anend.net:8443",
                         "https://example.test", "https://8.8.8.8", "https://127.0.0.1", "https://169.254.1.2",
                         "https://192.168.1.2/", "https://192.168.1.2:0", "https://192.168.1.2:65536",
                         "https://192.168.1.2:0443", "https://user@192.168.1.2", "https://[fd00::1]"):
            with self.subTest(endpoint=endpoint), self.assertRaises(host.BootstrapError):
                self.frame(backend=self.backend | dict(endpoint=endpoint))
        for endpoint in ("https://10.0.0.2", "https://172.16.0.2:443", "https://192.168.1.2:65535"):
            self.frame(backend=self.backend | dict(endpoint=endpoint))

    def test_production_host_guard_matches_firmware(self):
        header = (Path(__file__).resolve().parents[2] / "components/cp_settings/include/cp_settings.h").read_text()
        match = re.search(r'^#define CP_API_ORIGIN "https://([^"/]+)"$', header, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertEqual(host.PRODUCTION_HOST, match[1])

    def test_public_mode_requires_explicit_permission_and_omits_private_ca(self):
        with self.assertRaises(host.BootstrapError):
            self.frame(backend=self.public_backend)
        for permission in (1, "true", None):
            with self.assertRaises(host.BootstrapError):
                self.frame(backend=self.public_backend, allow_public_test=permission)
        value = json.loads(self.frame(backend=self.public_backend, allow_public_test=True)[8:])
        self.assertEqual(value["origin"], self.public_backend["endpoint"])
        self.assertEqual(value["device_token"], SECRET)
        self.assertNotIn("server_ca_pem", value)
        self.assertNotIn("server_ca_file", value)
        self.assertNotIn("tls", value)
        self.assertEqual(set(value), {"node_id", "boot_id", "origin", "device_token", "ssid", "password",
                                     "security", "utc_ms", "uncertainty_ms", "anchor_mono_ms", "max_windows"})

    def test_public_mode_accepts_strict_dns_and_global_ipv4(self):
        for endpoint in ("https://trial.example.org", "https://trial.example.org:443",
                         "https://a-b.c2.example.org:65535", "https://8.8.8.8", "https://1.1.1.1:8443"):
            with self.subTest(endpoint=endpoint):
                self.frame(backend=self.public_backend | dict(endpoint=endpoint), allow_public_test=True)

    def test_public_mode_rejects_unsafe_and_ambiguous_origin_syntax(self):
        endpoints = ("http://trial.example.org", "HTTPS://trial.example.org", "https://TRIAL.Example.ORG:443", "https://trial.example.org/",
                     "https://trial.example.org/path", "https://trial.example.org?query", "https://trial.example.org#fragment",
                     "https://user@trial.example.org", "https://user:pass@trial.example.org", "https://trial.example.org:",
                     "https://trial.example.org:0", "https://trial.example.org:65536", "https://trial.example.org:0443",
                     "https://trial.example.org:+443", "https://trial.example.org:443:80", "https://trial.example.org:443\n",
                     "https://trial.example.org.", "https://.example.org", "https://trial..example.org",
                     "https://-trial.example.org", "https://trial-.example.org", "https://trial_name.example.org",
                     "https://" + "a" * 64 + ".org", "https://" + "a." * 64 + "org", "https://localhost",
                     "https://trial.example.123", "https://trial.example.org\\path", "https://trial.example.org%2fpath",
                     "https://试验.example.org", "https://trial.example.org\x00", "https://trial.example.org ",
                     "https://8.8.8", "https://008.8.8.8", "https://8.8.8.256", "https://134744072",
                     "https://0x08080808", "https://0x8.0x8.0x8.0x8", "https://[2606:4700:4700::1111]")
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint), self.assertRaises(host.BootstrapError):
                self.frame(backend=self.public_backend | dict(endpoint=endpoint), allow_public_test=True)

    def test_public_mode_rejects_nonpublic_ipv4_and_production_variants(self):
        for address in ("0.0.0.0", "10.0.0.2", "172.16.0.2", "192.168.1.2", "127.0.0.1", "169.254.1.2",
                        "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
                        "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255"):
            with self.subTest(address=address), self.assertRaises(host.BootstrapError):
                self.frame(backend=self.public_backend | dict(endpoint="https://" + address), allow_public_test=True)
        production = host.PRODUCTION_HOST
        for authority in (production, production.upper(), production + ":443", production + ":8443",
                          production + ".", production.upper() + ".:443", "test." + production,
                          "user@" + production, "%70" + production[1:], production + "/",
                          production + "?test", production + "#test"):
            with self.subTest(authority=authority), self.assertRaises(host.BootstrapError):
                self.frame(backend=self.public_backend | dict(endpoint="https://" + authority), allow_public_test=True)

    def test_public_mode_requires_exact_tls_marker_and_absent_private_ca_fields(self):
        backend = {key: value for key, value in self.public_backend.items() if key != "tls"}
        for fields in ({}, dict(tls=None), dict(tls=True), dict(tls="PUBLIC_CA_BUNDLE"),
                       dict(tls="public_ca_bundle "), dict(tls="insecure"), dict(tls="private_ca")):
            with self.subTest(fields=fields), self.assertRaises(host.BootstrapError):
                self.frame(backend=backend | fields, allow_public_test=True)
        for key in ("server_ca_pem", "server_ca_file", "server_ca_path"):
            for value in (None, "", False, self.ca):
                with self.subTest(key=key, value_type=type(value)), self.assertRaises(host.BootstrapError):
                    self.frame(backend=self.public_backend | {key: value}, allow_public_test=True)

    def test_bearer_length_matches_board_in_both_modes(self):
        for backend, public in ((self.backend, False), (self.public_backend, True)):
            for length in (0, 1, 31, 193):
                with self.subTest(public=public, length=length), self.assertRaises(host.BootstrapError):
                    self.frame(backend=backend | dict(device_bearer="a" * length), allow_public_test=public)
            for length in (32, 192):
                self.frame(backend=backend | dict(device_bearer="a" * length), allow_public_test=public)

    def test_invalid_and_oversized_ca(self):
        invalid = ("", self.leaf, self.ca+self.ca, "prefix"+self.ca, self.ca+"suffix",
                   self.ca.replace("\n", "\r"), self.ca.replace("A", "!", 1),
                   "x" * 4097, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")
        for ca in invalid:
            with self.subTest(length=len(ca)), self.assertRaises(host.BootstrapError):
                self.frame(backend=self.backend | dict(server_ca_pem=ca))
        self.frame(backend=self.backend | dict(server_ca_pem=self.ca.replace("\n", "\r\n")))

    def test_ascii_and_field_limits(self):
        for changes in (dict(ssid="汉字"), dict(ssid="s"*33), dict(password="s"*64),
                        dict(password="short"), dict(password="secret\nvalue"), dict(security="open")):
            with self.subTest(changes=changes), self.assertRaises(host.BootstrapError):
                self.frame(wifi=self.wifi | changes)
        for changes in (dict(device_bearer="x"*193), dict(device_bearer="bad\r\nvalue"), dict(node_id="node")):
            with self.assertRaises(host.BootstrapError):
                self.frame(backend=self.backend | changes)
        value = json.loads(self.frame(wifi=dict(ssid='quoted"\\ssid', password='quoted"\\password'))[8:])
        self.assertEqual(value["ssid"], 'quoted"\\ssid')
        self.frame(wifi=self.wifi | dict(password="aB01" * 16))
        with self.assertRaises(host.BootstrapError):
            self.frame(wifi=self.wifi | dict(password="a" * 65))

    def test_encoded_length_includes_prefix_and_escaping(self):
        # A raw-string check would miss the extra JSON escape bytes.
        prefix = len('V3START {"x":""}')
        exact = host.encode_frame(dict(x="x" * (8191-prefix)))
        self.assertEqual(len(exact), 8192)
        with self.assertRaises(host.BootstrapError):
            host.encode_frame(dict(x="x" * (8192-prefix)))
        with self.assertRaises(host.BootstrapError):
            host.encode_frame(dict(x="\\" * 4090))

    def test_secure_private_reader(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            root = Path(directory)
            file = root / "input.json"
            file.write_text(json.dumps(self.backend))
            file.chmod(0o600)
            self.assertEqual(host.read_private_json(file), self.backend)
            for mode in (0o644, 0o640, 0o400, 0o700):
                file.chmod(mode)
                with self.assertRaises(host.BootstrapError):
                    host.read_private_json(file)
            file.chmod(0o600)
            (root / "link").symlink_to(file)
            with self.assertRaises(host.BootstrapError):
                host.read_private_json(root / "link")
            (root / "dirlink").symlink_to(root, target_is_directory=True)
            with self.assertRaises(host.BootstrapError):
                host.read_private_json(root / "dirlink/input.json")
            os.link(file, root / "hardlink")
            with self.assertRaises(host.BootstrapError):
                host.read_private_json(file)
            (root / "hardlink").unlink()
            os.mkfifo(root / "fifo", 0o600)
            with self.assertRaises(host.BootstrapError):
                host.read_private_json(root / "fifo")
            with mock.patch.object(host.os, "geteuid", return_value=os.geteuid()+1):
                with self.assertRaises(host.BootstrapError):
                    host.read_private_json(file)
            file.write_text("x" * (host.MAX_INPUT+1))
            with self.assertRaises(host.BootstrapError):
                host.read_private_json(file)
            file.write_text('{"x":1,"x":2}')
            with self.assertRaises(host.BootstrapError):
                host.read_private_json(file)
            for data in ("[]", '{"x":NaN}', "invalid", '{"password":"'+SECRET+'",}'):
                file.write_text(data)
                with self.assertRaises(host.BootstrapError) as error:
                    host.read_private_json(file)
                self.assertNotIn(SECRET, str(error.exception))

    def test_accepted_closes_wipes_and_does_not_log(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            port = self.session()
        self.assertEqual(output.getvalue(), "")
        self.assertTrue(port.closed)
        self.assertEqual(port.resets, 2)
        self.assertEqual(len(port.records), 2)
        self.assertTrue(port.records[1].startswith(b"V3START "))
        self.assertEqual(set(port.frame_ref), {0})

    def test_public_fake_serial_sends_bundle_frame_closes_and_wipes(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            port = self.session(backend=self.public_backend, allow_public_test=True)
        self.assertEqual(output.getvalue(), "")
        self.assertTrue(port.opened and port.closed)
        self.assertEqual(len(port.records), 2)
        payload = json.loads(port.records[1][8:])
        self.assertEqual(payload["origin"], self.public_backend["endpoint"])
        self.assertNotIn("server_ca_pem", payload)
        self.assertEqual(set(port.frame_ref), {0})

    def test_public_validation_fails_before_serial_factory(self):
        cases = ((self.public_backend, False), (self.public_backend | dict(tls="insecure"), True),
                 (self.public_backend | dict(server_ca_pem=None), True),
                 (self.public_backend | dict(endpoint="https://" + host.PRODUCTION_HOST), True),
                 (self.public_backend | dict(device_bearer="a" * 31), True), (self.backend, True))
        for backend, permission in cases:
            factory = mock.Mock()
            with self.assertRaises(host.BootstrapError):
                host.run_bootstrap(backend, self.wifi, "fake-port", serial_factory=factory,
                                   allow_public_test=permission)
            factory.assert_not_called()

    def test_wrong_node_never_receives_credentials(self):
        def configure(port):
            port.reply = lambda nonce: b"V3 HELLO " + json.dumps(hello(nonce) | dict(node_id="cp_ffeeddccbbaa")).encode() + b"\n"
        with self.assertRaisesRegex(host.BootstrapError, "node mismatch"):
            self.session(configure)
        self.assertTrue(self.last_port.closed)
        self.assertTrue(all(not r.startswith(b"V3START ") for r in self.last_port.records))

    def test_stale_nonce_is_ignored_and_runtime_gate_fails_closed(self):
        def stale(port):
            port.reply = lambda nonce: b"V3 HELLO " + json.dumps(hello("f"*32)).encode() + b"\n"
        with self.assertRaisesRegex(host.BootstrapError, "HELLO timed out"):
            self.session(stale, hello_attempts=1)
        self.assertEqual(len(self.last_port.records), 1)
        def blocked(port):
            port.reply = lambda nonce: b"log runtime_blocked=statistics_contract_and_storage_unavailable\n"
        with self.assertRaisesRegex(host.BootstrapError, "gate is closed"):
            self.session(blocked)
        self.assertEqual(len(self.last_port.records), 1)

    def test_hello_retries_use_fresh_nonce(self):
        nonces = iter(["a"*32, "b"*32])
        def configure(port):
            original = port.reply
            port.reply = lambda nonce: b"" if nonce == "a"*32 else original(nonce)
        port = self.session(configure, nonce_factory=lambda: next(nonces), hello_attempts=2)
        self.assertEqual(port.records[0], b"HELLO " + b"a"*32)
        self.assertEqual(port.records[1], b"HELLO " + b"b"*32)

    def test_repeated_nonce_is_not_reused(self):
        with self.assertRaisesRegex(host.BootstrapError, "invalid host nonce"):
            self.session(lambda port: setattr(port, "reply", lambda nonce: b""), hello_attempts=2)
        self.assertEqual(len(self.last_port.records), 1)

    def test_anchor_expires_during_frame_preparation(self):
        original = host.build_frame
        def configure(port):
            self.session_clock = port.clock
        def slow_frame(*args, **kwargs):
            frame = original(*args, **kwargs)
            self.session_clock.now += 2001
            return frame
        with mock.patch.object(host, "build_frame", side_effect=slow_frame):
            with self.assertRaisesRegex(host.BootstrapError, "anchor expired"):
                self.session(configure)
        self.assertEqual(len(self.last_port.records), 1)
        self.assertTrue(self.last_port.closed)

    def test_interrupt_closes_and_wipes_frame(self):
        def configure(port):
            original = port.write
            def interrupt_frame(data):
                if bytes(data).startswith(b"V3START "):
                    port.frame_ref = data.obj
                    raise KeyboardInterrupt()
                return original(data)
            port.write = interrupt_frame
        with self.assertRaises(KeyboardInterrupt):
            self.session(configure)
        self.assertEqual(set(self.last_port.frame_ref), {0})
        self.assertTrue(self.last_port.closed)

    def test_oversized_noise_partial_lines_and_fake_success_are_not_acceptance(self):
        def noise(port):
            original = port.reply
            port.reply = lambda nonce: b"x"*9000+b"\n"+original(nonce)
        # Reading the noise exceeds the RTT bound: no credential frame is sent.
        with self.assertRaises(host.BootstrapError):
            self.session(noise, hello_attempts=1)
        for ack in (b"V3 TEST PASSED\n", b"V3 START ACCEPTED", b"prefix V3 START ACCEPTED\n", b"echo "+SECRET.encode()+b"\n"):
            with self.subTest(ack=ack), self.assertRaisesRegex(host.BootstrapError, "acceptance timed out"):
                self.session(lambda port: setattr(port, "ack", ack), accept_timeout_ms=500)
            self.assertEqual(set(self.last_port.frame_ref), {0})
            self.assertTrue(self.last_port.closed)

    def test_stale_acceptance_before_send_is_discarded(self):
        def configure(port):
            original = port.reply
            port.reply = lambda nonce: original(nonce) + b"V3 START ACCEPTED\n"
            port.ack = b""
        with self.assertRaisesRegex(host.BootstrapError, "acceptance timed out"):
            self.session(configure, accept_timeout_ms=300)

    def test_rejection_timeout_failures_cleanup_without_secret_leak(self):
        cases = (lambda port: setattr(port, "ack", b"V3 ERR BOOTSTRAP\n"),
                 lambda port: setattr(port, "reply", lambda nonce: b""),
                 lambda port: setattr(port, "failure", "open"),
                 lambda port: setattr(port, "failure", "write"),
                 lambda port: setattr(port, "failure", "read"),
                 lambda port: setattr(port, "max_write", 0))
        for configure in cases:
            output = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                with self.assertRaises(host.BootstrapError) as error:
                    self.session(configure, hello_attempts=1)
            self.assertNotIn(SECRET, str(error.exception))
            self.assertEqual(output.getvalue(), "")
            self.assertTrue(self.last_port.closed)

    def test_partial_writes_and_serial_timeout_after_frame_are_wiped(self):
        port = self.session(lambda port: setattr(port, "max_write", 17))
        self.assertTrue(port.closed)
        def configure(port):
            original = port.write
            def fail_frame(data):
                if bytes(data).startswith(b"V3START "):
                    port.frame_ref = data.obj
                    raise TimeoutError(SECRET)
                return original(data)
            port.write = fail_frame
        with self.assertRaises(host.BootstrapError) as error:
            self.session(configure)
        self.assertNotIn(SECRET, str(error.exception))
        self.assertTrue(self.last_port.closed)
        self.assertEqual(set(self.last_port.frame_ref), {0})

    def test_no_device_opened_with_invalid_configuration(self):
        factory = mock.Mock()
        with self.assertRaises(host.BootstrapError):
            host.run_bootstrap(self.backend | dict(server_ca_pem="bad"), self.wifi, "fake-port", serial_factory=factory)
        factory.assert_not_called()

    def test_cli_default_validates_without_usb_or_network(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            root = Path(directory)
            backend_file = root / "backend-bootstrap-tenergy.json"
            wifi_file = root / "wifi.json"
            backend_file.write_text(json.dumps(self.backend))
            wifi_file.write_text(json.dumps(self.wifi))
            backend_file.chmod(0o600)
            wifi_file.chmod(0o600)
            output = io.StringIO()
            with mock.patch.object(host, "run_bootstrap", side_effect=AssertionError("USB forbidden")):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    result = host.main(["--private-dir", str(root), "--wifi-file", str(wifi_file)])
            self.assertEqual(result, 0)
            self.assertIn("No device opened", output.getvalue())
            for secret in (SECRET, self.wifi["password"], self.wifi["ssid"], NODE, self.backend["endpoint"]):
                self.assertNotIn(secret, output.getvalue())
            backend_file.write_text('{"credential":"'+SECRET+'" invalid}')
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                self.assertEqual(host.main(["--private-dir", str(root), "--wifi-file", str(wifi_file)]), 1)
            self.assertNotIn(SECRET, output.getvalue())

    def test_public_cli_opt_in_does_not_enable_serial_and_send_uses_fake_serial(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            root = Path(directory)
            backend_file = root / "backend-bootstrap-tenergy.json"
            wifi_file = root / "wifi.json"
            backend_file.write_text(json.dumps(self.public_backend))
            wifi_file.write_text(json.dumps(self.wifi))
            backend_file.chmod(0o600)
            wifi_file.chmod(0o600)
            arguments = ["--private-dir", str(root), "--wifi-file", str(wifi_file)]
            output = io.StringIO()
            with mock.patch.object(host, "run_bootstrap", side_effect=AssertionError("USB forbidden")):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    self.assertEqual(host.main(arguments), 1)
                    self.assertEqual(host.main(arguments + ["--allow-public-test"]), 0)
                    self.assertEqual(host.main(arguments + ["--send", "--port", "fake-port"]), 1)
            self.assertIn("No device opened", output.getvalue())
            clock = Clock()
            port = Serial(clock, port=None, timeout=.1, write_timeout=1, baudrate=115200)
            factory = mock.Mock(return_value=port)
            with mock.patch.dict("sys.modules", {"serial": mock.Mock(Serial=factory)}):
                with mock.patch.object(host, "Clock", return_value=clock):
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                        self.assertEqual(host.main(arguments + ["--allow-public-test", "--send", "--port", "fake-port"]), 0)
            factory.assert_called_once_with(port=None, baudrate=115200, timeout=.1, write_timeout=1)
            self.assertTrue(port.opened and port.closed)
            payload = json.loads(port.records[1][8:])
            self.assertEqual(payload["origin"], self.public_backend["endpoint"])
            self.assertNotIn("server_ca_pem", payload)
            self.assertEqual(set(port.frame_ref), {0})
            for secret in (SECRET, self.wifi["password"], self.wifi["ssid"], NODE, self.public_backend["endpoint"]):
                self.assertNotIn(secret, output.getvalue())


    def test_production_requires_separate_permission_and_bundle(self):
        backend = self.public_backend | dict(endpoint="https://pulse.anend.net")
        for options in ({}, dict(allow_public_test=True)):
            with self.assertRaises(host.BootstrapError):
                self.frame(backend=backend, **options)
        payload = json.loads(self.frame(backend=backend, allow_production=True)[8:])
        self.assertEqual(payload["origin"], backend["endpoint"])
        self.assertNotIn("server_ca_pem", payload)
        for fields in (dict(server_ca_pem=""), dict(server_ca_pem=self.ca), dict(server_ca_file="private"), dict(tls="other")):
            with self.assertRaises(host.BootstrapError):
                self.frame(backend=backend | fields, allow_production=True)
        for endpoint in ("https://pulse.anend.net:443", "https://pulse.anend.net:8443", "https://sub.pulse.anend.net", "https://pulse.anend.net.", "https://pulse.anend.net/", "https://trial.example.org"):
            with self.assertRaises(host.BootstrapError):
                self.frame(backend=backend | dict(endpoint=endpoint), allow_production=True)
        with self.assertRaises(host.BootstrapError):
            self.frame(backend=backend, allow_production=True, allow_public_test=True)
        for permission in (1, "yes", None):
            with self.assertRaises(host.BootstrapError):
                self.frame(backend=backend, allow_production=permission)

    def test_production_permission_survives_serial_call_chain(self):
        backend = self.public_backend | dict(endpoint="https://pulse.anend.net")
        port = self.session(backend=backend, allow_production=True)
        self.assertEqual(json.loads(port.records[1][8:])["origin"], backend["endpoint"])
        for options in ({}, dict(allow_public_test=True)):
            factory = mock.Mock(side_effect=AssertionError("must fail before USB open"))
            with self.assertRaises(host.BootstrapError):
                host.run_bootstrap(backend, self.wifi, "fake", serial_factory=factory, **options)
            factory.assert_not_called()

if __name__ == "__main__":
    unittest.main()
