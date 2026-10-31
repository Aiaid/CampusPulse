#!/usr/bin/env python3
"""Prepare a private USB bootstrap for the isolated T-Energy V3 trial.

Default: validate inputs only. --send explicitly enables USB IO; this never
opens a network connection or uploads raw data on the host. The bounded runtime
requires separate real-device acceptance; the legacy experimental gate stays closed.
An accepted bootstrap does not establish TLS, collection, upload or test success.

Inputs: private-dir/backend-bootstrap-tenergy.json and an explicitly selected
private Wi-Fi JSON file (ssid/password, optional security='personal'). Backend
metadata is permitted. The default requires a LAN IPv4 origin and a single CA.
--allow-public-test explicitly permits a strict HTTPS DNS/public IPv4 origin
only with tls='public_ca_bundle' and no server_ca_* fields. The resulting frame
omits server_ca_pem so the board uses its existing trusted public CA bundle;
TLS verification is never disabled. --allow-production separately permits only
the exact https://pulse.anend.net origin with the public CA bundle and no CA fields.
DNS is never resolved here, so aliases and routing are not independently checked.
server_ca_file is never opened. Input files must be owned regular files,
mode 0600, with no symbolic-link path components. No credentials enter argv.

The host clock is a trusted operator input with a declared 250 ms absolute
error allowance, not an independently verified UTC source. Python immutable
strings cannot be reliably wiped; the outbound mutable frame is wiped on all
exit paths, and no raw serial/configuration data is logged or printed.
"""
from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

MAX_LINE = 8191  # Prefix included; terminating LF excluded, as on the board.
MAX_INPUT = 32768
NODE_RE = re.compile(r"cp_[0-9a-f]{12}\Z")
BOOT_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
NONCE_RE = re.compile(r"[0-9a-f]{32}\Z")
LAN_NETS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
# Keep aligned with firmware/components/cp_settings/include/cp_settings.h;
# the host test checks this against CP_API_ORIGIN without runtime file IO.
PRODUCTION_HOST = "pulse.anend.net"
DNS_LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z")


class BootstrapError(Exception):
    """Fixed public diagnostic; never include input or exception text."""


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BootstrapError("duplicate JSON field")
        result[key] = value
    return result


def _json(data):
    try:
        value = json.loads(data, object_pairs_hook=_unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if type(value) is not dict:
            raise ValueError()
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise BootstrapError("invalid JSON input") from None


def read_private_json(path):
    """Open each component with O_NOFOLLOW; fstat/read the same final fd."""
    fd = None
    try:
        # Do not resolve(): that would hide symbolic links before checking them.
        absolute = os.path.abspath(os.fspath(path))
        parts = Path(absolute).parts[1:]
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        for component in parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        next_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        os.close(fd)
        fd = next_fd
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_size > MAX_INPUT):
            raise BootstrapError("private input must be an owned regular mode-0600 file")
        data = bytearray()
        try:
            while len(data) <= MAX_INPUT:
                chunk = os.read(fd, min(4096, MAX_INPUT + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) > MAX_INPUT:
                raise BootstrapError("private input exceeds size limit")
            return _json(data)
        finally:
            data[:] = b"\0" * len(data)
    except (OSError, IndexError, TypeError):
        raise BootstrapError("cannot securely read private input") from None
    finally:
        if fd is not None:
            os.close(fd)


def _text(value, minimum, maximum):
    if (type(value) is not str or not minimum <= len(value) <= maximum
            or any(not 32 <= ord(c) <= 126 for c in value)):
        raise BootstrapError("invalid bootstrap text field")
    return value


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise BootstrapError("invalid bootstrap integer field")
    return value


def validate_ca(pem):
    """Match the board's single canonical PEM envelope and real X.509 CA check."""
    if type(pem) is not str or not 1 <= len(pem) <= 4096 or not pem.isascii():
        raise BootstrapError("invalid single CA certificate")
    lines = pem.replace("\r\n", "\n").split("\n")
    if lines[-1] == "":
        lines.pop()
    if len(lines) < 3 or lines[0] != "-----BEGIN CERTIFICATE-----" or lines[-1] != "-----END CERTIFICATE-----":
        raise BootstrapError("invalid single CA certificate")
    body = lines[1:-1]
    if any(not re.fullmatch(r"[A-Za-z0-9+/]{1,64}={0,2}", s) or len(s) > 64 or len(s) % 4 for s in body):
        raise BootstrapError("invalid single CA certificate")
    if any(len(s) != 64 or "=" in s for s in body[:-1]):
        raise BootstrapError("invalid single CA certificate")
    try:
        encoded = "".join(body)
        der = base64.b64decode(encoded, validate=True)
        if base64.b64encode(der).decode("ascii") != encoded:
            raise ValueError()
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding
        cert = x509.load_der_x509_certificate(der)
        if cert.public_bytes(Encoding.DER) != der or not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError()
    except ImportError:
        raise BootstrapError("cryptography dependency unavailable") from None
    except Exception:
        raise BootstrapError("invalid single CA certificate") from None
    return pem


def validate_public_origin(origin):
    """Strict origin syntax only; do not resolve names or open connections."""
    # The device transport accepts lowercase DNS only; do not accept a host
    # frame that the board will later reject.
    match = re.fullmatch(r"https://([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?", origin)
    if not match or (match[2] and int(match[2]) > 65535):
        raise BootstrapError("endpoint must be an isolated HTTPS DNS or public IPv4 origin")
    hostname = match[1].lower()
    if hostname == PRODUCTION_HOST or hostname.endswith("." + PRODUCTION_HOST):
        raise BootstrapError("production endpoint is forbidden for isolated tests")
    if re.fullmatch(r"[0-9.]+", hostname):
        try:
            address = ipaddress.IPv4Address(hostname)
        except ValueError:
            raise BootstrapError("endpoint must be an isolated HTTPS DNS or public IPv4 origin") from None
        if not address.is_global or address.is_multicast or address.is_reserved:
            raise BootstrapError("endpoint must be an isolated HTTPS DNS or public IPv4 origin")
    else:
        labels = hostname.split(".")
        # A nonnumeric final label prevents alternate IPv4 encodings from being
        # interpreted as DNS by this tool and as an address by the TLS client.
        if (len(labels) < 2 or not re.fullmatch(r"[a-z][a-z0-9-]*", labels[-1])
                or any(not DNS_LABEL_RE.fullmatch(label) for label in labels)):
            raise BootstrapError("endpoint must be an isolated HTTPS DNS or public IPv4 origin")
    return origin


def validate_inputs(backend, wifi, *, allow_public_test=False, allow_production=False):
    try:
        if type(allow_public_test) is not bool or type(allow_production) is not bool or (allow_public_test and allow_production):
            raise BootstrapError("endpoint permission must be explicit and unambiguous")
        node = _text(backend["node_id"], 15, 15)
        if not NODE_RE.fullmatch(node):
            raise BootstrapError("invalid T-Energy node identity")
        origin = _text(backend["endpoint"], 1, 127)
        ca_fields = {}
        if allow_production:
            if origin != "https://" + PRODUCTION_HOST:
                raise BootstrapError("production permission requires the canonical production origin")
            if (backend.get("tls") != "public_ca_bundle"
                    or any(key.startswith("server_ca_") for key in backend)):
                raise BootstrapError("production requires the public CA bundle without private CA fields")
        elif allow_public_test:
            validate_public_origin(origin)
            if (backend.get("tls") != "public_ca_bundle"
                    or any(key.startswith("server_ca_") for key in backend)):
                raise BootstrapError("public test requires the public CA bundle without private CA fields")
        else:
            match = re.fullmatch(r"https://([0-9.]+)(?::([1-9][0-9]{0,4}))?", origin)
            if not match:
                raise BootstrapError("endpoint must be an isolated HTTPS LAN IPv4 origin")
            ip = ipaddress.IPv4Address(match[1])
            if not any(ip in network for network in LAN_NETS) or (match[2] and int(match[2]) > 65535):
                raise BootstrapError("endpoint must be an isolated HTTPS LAN IPv4 origin")
            ca_fields["server_ca_pem"] = validate_ca(backend["server_ca_pem"])
        token = _text(backend["device_bearer"], 32, 192)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            raise BootstrapError("invalid device bearer")
        ssid = _text(wifi["ssid"], 1, 32)
        password = _text(wifi["password"], 8, 64)
        if len(password) == 64 and not re.fullmatch(r"[0-9A-Fa-f]{64}", password):
            raise BootstrapError("64-character Wi-Fi key must be hexadecimal")
        if wifi.get("security", "personal") != "personal":
            raise BootstrapError("only personal Wi-Fi is supported")
        return dict(node_id=node, origin=origin, device_token=token,
                    ssid=ssid, password=password, security="personal", **ca_fields)
    except (KeyError, TypeError, ValueError):
        raise BootstrapError("invalid private bootstrap configuration") from None


def validate_hello(hello, node_id, request_id):
    if type(hello) is not dict or set(hello) != {"node_id", "boot_id", "request_id", "mono_ms"}:
        raise BootstrapError("invalid HELLO identity")
    if hello["request_id"] != request_id or not NONCE_RE.fullmatch(request_id):
        raise BootstrapError("HELLO nonce mismatch")
    if hello["node_id"] != node_id or not NODE_RE.fullmatch(node_id):
        raise BootstrapError("HELLO node mismatch")
    if type(hello["boot_id"]) is not str or not BOOT_RE.fullmatch(hello["boot_id"]):
        raise BootstrapError("invalid HELLO boot identity")
    _integer(hello["mono_ms"], 0, 9007199254740991)
    return hello


def encode_frame(payload):
    # ensure_ascii alone would silently admit non-ASCII source strings; callers
    # validate their schema first. This also bounds JSON escaping, not just PEM.
    wire = ("V3START " + json.dumps(payload, ensure_ascii=True, separators=(",", ":"), allow_nan=False)).encode("ascii")
    if len(wire) > MAX_LINE or any(c < 32 or c > 126 for c in wire):
        raise BootstrapError("encoded bootstrap exceeds ASCII record limit")
    return bytearray(wire + b"\n")


def build_frame(backend, wifi, hello, request_id, sent_wall_ms, sent_mono_ms,
                received_wall_ms, received_mono_ms, *, windows=1, allow_public_test=False, allow_production=False):
    """Pure schema/time/frame operation; no file, serial or network IO."""
    payload = validate_inputs(backend, wifi, allow_public_test=allow_public_test, allow_production=allow_production)
    validate_hello(hello, payload["node_id"], request_id)
    for value in (sent_wall_ms, received_wall_ms):
        _integer(value, 1704067200000, 4102444799000)
    for value in (sent_mono_ms, received_mono_ms):
        _integer(value, 0, 9007199254740991)
    rtt = received_mono_ms - sent_mono_ms
    if not 0 <= rtt <= 2000 or abs(received_wall_ms - sent_wall_ms - rtt) > 20:
        raise BootstrapError("host clock exchange is not bounded")
    payload.update(boot_id=hello["boot_id"], utc_ms=(sent_wall_ms + received_wall_ms) // 2,
                   uncertainty_ms=(rtt + 1) // 2 + 251,
                   anchor_mono_ms=hello["mono_ms"], max_windows=_integer(windows, 1, 3))
    return encode_frame(payload)


class Clock:
    def wall_ms(self):
        return time.time_ns() // 1_000_000

    def mono_ms(self):
        return time.monotonic_ns() // 1_000_000


class LineReader:
    """Bounded physical records; partial reads never become partial records."""
    def __init__(self, port, clock):
        self.port, self.clock = port, clock
        self.buffer = bytearray()
        self.overflow = False

    def next(self, deadline):
        while self.clock.mono_ms() < deadline:
            byte = self.port.read(1)
            if not byte:
                continue
            if byte == b"\n":
                value = None
                if not self.overflow:
                    try:
                        value = self.buffer.removesuffix(b"\r").decode("ascii")
                    except UnicodeError:
                        pass
                self.buffer[:] = b"\0" * len(self.buffer)
                self.buffer.clear()
                self.overflow = False
                if value is not None:
                    return value
            elif len(self.buffer) < MAX_LINE and not self.overflow:
                self.buffer.extend(byte)
            else:
                self.overflow = True
        return None

    def clear(self):
        self.buffer[:] = b"\0" * len(self.buffer)
        self.buffer.clear()


def _write(port, frame, clock):
    deadline = clock.mono_ms() + 2000
    offset = 0
    while offset < len(frame):
        if clock.mono_ms() >= deadline:
            raise BootstrapError("USB write timed out")
        count = port.write(memoryview(frame)[offset:])
        if type(count) is not int or count <= 0 or count > len(frame) - offset:
            raise BootstrapError("USB write incomplete")
        offset += count


def run_bootstrap(backend, wifi, port_name, *, serial_factory, clock=None,
                  nonce_factory=lambda: uuid.uuid4().hex, windows=1,
                  hello_attempts=3, hello_timeout_ms=2000, accept_timeout_ms=5000,
                  allow_public_test=False, allow_production=False):
    """Serial only; closes even after open/write/read failures. Never logs RX."""
    validate_inputs(backend, wifi, allow_public_test=allow_public_test, allow_production=allow_production)  # Fail closed before opening a device.
    _integer(windows, 1, 3)
    _integer(hello_attempts, 1, 15)
    _integer(hello_timeout_ms, 1, 2000)
    _integer(accept_timeout_ms, 1, 30000)
    clock = clock or Clock()
    port = reader = frame = None
    try:
        port = serial_factory(port=None, baudrate=115200, timeout=0.1, write_timeout=1)
        port.dtr = False
        port.rts = False
        port.port = port_name
        port.open()
        port.reset_input_buffer()
        reader = LineReader(port, clock)
        hello = None
        used_nonces = set()
        for _ in range(hello_attempts):
            request_id = nonce_factory()
            if type(request_id) is not str or not NONCE_RE.fullmatch(request_id) or request_id in used_nonces:
                raise BootstrapError("invalid host nonce")
            used_nonces.add(request_id)
            sent_wall, sent_mono = clock.wall_ms(), clock.mono_ms()
            _write(port, ("HELLO " + request_id + "\n").encode("ascii"), clock)
            deadline = sent_mono + hello_timeout_ms
            while clock.mono_ms() < deadline:
                line = reader.next(deadline)
                if line is None:
                    break
                if "runtime_blocked=" in line:
                    raise BootstrapError("device runtime gate is closed")
                if not line.startswith("V3 HELLO "):
                    continue
                received_wall, received_mono = clock.wall_ms(), clock.mono_ms()
                candidate = _json(line[9:])
                # Delayed replies to earlier nonces never authorize credentials.
                if candidate.get("request_id") != request_id:
                    continue
                validate_hello(candidate, backend["node_id"], request_id)
                hello = candidate
                break
            if hello is not None:
                break
        if hello is None:
            raise BootstrapError("fresh HELLO timed out; no bootstrap sent")
        frame = build_frame(backend, wifi, hello, request_id, sent_wall, sent_mono,
                            received_wall, received_mono, windows=windows,
                            allow_public_test=allow_public_test, allow_production=allow_production)
        current_wall, current_mono = clock.wall_ms(), clock.mono_ms()
        age = current_mono - received_mono
        if not 0 <= age <= 2000 or abs(current_wall - received_wall - age) > 20:
            raise BootstrapError("HELLO time anchor expired before sending")
        # Discard queued pre-send responses, including a stale acceptance line.
        reader.clear()
        port.reset_input_buffer()
        _write(port, frame, clock)
        frame[:] = b"\0" * len(frame)
        deadline = clock.mono_ms() + accept_timeout_ms
        while clock.mono_ms() < deadline:
            line = reader.next(deadline)
            if line == "V3 START ACCEPTED":
                return
            if line == "V3 ERR BOOTSTRAP":
                raise BootstrapError("device rejected bootstrap")
            if line and "runtime_blocked=" in line:
                raise BootstrapError("device runtime gate is closed")
        raise BootstrapError("bootstrap acceptance timed out; device state unknown")
    except BootstrapError:
        raise
    except Exception:
        raise BootstrapError("USB bootstrap failed; private values withheld") from None
    finally:
        if frame is not None:
            frame[:] = b"\0" * len(frame)
        if reader is not None:
            reader.clear()
        if port is not None:
            try:
                port.close()
            except Exception:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--private-dir", type=Path, required=True)
    parser.add_argument("--wifi-file", type=Path, required=True, help="authorized private Wi-Fi JSON; never a password argument")
    parser.add_argument("--send", action="store_true", help="explicitly open USB and send the bounded runtime bootstrap")
    origins = parser.add_mutually_exclusive_group()
    origins.add_argument("--allow-public-test", action="store_true", help="explicitly permit an isolated HTTPS DNS/public IPv4 test origin using the public CA bundle; does not enable USB")
    origins.add_argument("--allow-production", action="store_true", help="explicitly permit only canonical https://pulse.anend.net with the public CA bundle; does not enable USB")
    parser.add_argument("--port")
    parser.add_argument("--windows", type=int, choices=(1, 2, 3), default=1)
    args = parser.parse_args(argv)
    if args.send and not args.port:
        parser.error("--send requires --port")
    backend = wifi = None
    try:
        backend = read_private_json(args.private_dir / "backend-bootstrap-tenergy.json")
        wifi = read_private_json(args.wifi_file)
        validate_inputs(backend, wifi, allow_public_test=args.allow_public_test, allow_production=args.allow_production)
        if not args.send:
            print("Private inputs validated. No device opened. Real-device acceptance remains unverified.")
            return 0
        import serial
        run_bootstrap(backend, wifi, args.port, serial_factory=serial.Serial, windows=args.windows,
                      allow_public_test=args.allow_public_test, allow_production=args.allow_production)
        print("Bootstrap explicitly accepted. TLS, collection and upload remain unverified.")
        return 0
    except KeyboardInterrupt:
        print("Bootstrap interrupted; device state unknown; private values withheld.", file=sys.stderr)
        return 130
    except BootstrapError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print("Bootstrap failed; private values withheld.", file=sys.stderr)
        return 1
    finally:
        if backend is not None:
            backend.clear()
        if wifi is not None:
            wifi.clear()


if __name__ == "__main__":
    raise SystemExit(main())
