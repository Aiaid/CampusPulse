#!/usr/bin/env python3
"""Physical USB bootstrap only; the board performs every v3 HTTPS request."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid
import serial


def read_private(path):
    s = path.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077:
        raise ValueError('private input permissions required')
    return json.loads(path.read_text())


def validate_trial_endpoint(backend):
    """The historical per-address feature runner remains isolated-only."""
    origin = backend.get('endpoint')
    match = re.fullmatch(r'https://([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?', origin or '')
    if not match or (match[2] and int(match[2]) > 65535):
        raise ValueError('invalid isolated HTTPS endpoint')
    production_host = 'pulse.anend.net'  # CP_API_ORIGIN; checked by the host regression.
    if match[1] == production_host or match[1].endswith('.' + production_host):
        raise ValueError('historical feature runner cannot target production')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', required=True)
    p.add_argument('--private-dir', type=Path, required=True)
    p.add_argument('--windows', type=int, choices=(1, 2, 3), default=2)
    args = p.parse_args()
    directory = args.private_dir.resolve()
    os.chmod(directory, 0o700)
    backend = read_private(directory / 'backend-bootstrap.json')
    wifi = read_private(directory / 'wifi.json')
    validate_trial_endpoint(backend)
    port = serial.Serial(port=None, baudrate=115200, timeout=.2)
    port.dtr = False
    port.rts = False
    port.port = args.port
    port.open()
    logfd = os.open(directory / 'board-trial-serial.log', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with port, os.fdopen(logfd, 'w') as log:
        identity = None
        for _ in range(15):
            request_id = uuid.uuid4().hex
            sent_wall = time.time_ns() // 1_000_000
            sent_mono = time.monotonic_ns() // 1_000_000
            port.write(('HELLO ' + request_id + '\n').encode('ascii'))
            port.flush()
            until = time.monotonic() + 1
            while time.monotonic() < until:
                line = port.readline().decode(errors='replace')
                log.write(line)
                if line.startswith('V3 HELLO '):
                    candidate = json.loads(line[9:])
                    if candidate.get('request_id') != request_id:
                        continue
                    identity = candidate
                    received_wall = time.time_ns() // 1_000_000
                    received_mono = time.monotonic_ns() // 1_000_000
                    break
            if identity:
                break
        if not identity or identity['node_id'] != backend['node_id']:
            raise ValueError('actual board identity did not match isolated credential')
        if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', identity['boot_id']):
            raise ValueError('invalid actual boot identity')
        fd = os.open(directory / 'device-runtime.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(identity, out)
        rtt = received_mono - sent_mono
        if not 0 <= rtt <= 2000 or abs((received_wall - sent_wall) - rtt) > 20:
            raise ValueError('bootstrap clock exchange not bounded')
        # Physical host clock is a trusted test input with a declared 250 ms
        # absolute-error allowance; RTT bounds the device HELLO instant.
        bootstrap = dict(node_id=identity['node_id'], boot_id=identity['boot_id'],
                         origin=backend['endpoint'], device_token=backend['device_bearer'],
                         ssid=wifi['ssid'], password=wifi['password'], security='personal',
                         utc_ms=(sent_wall + received_wall) // 2,
                         uncertainty_ms=(rtt + 1) // 2 + 251,
                         anchor_mono_ms=identity['mono_ms'],
                         max_windows=args.windows)
        frame = bytearray(('V3START ' + json.dumps(bootstrap, separators=(',', ':')) + '\n').encode('ascii'))
        port.write(frame)
        port.flush()
        frame[:] = b'\0' * len(frame)
        bootstrap.clear()
        print('Physical bootstrap sent; waiting for board-owned v3 requests', flush=True)
        deadline = time.monotonic() + 720
        result = 'timeout'
        while time.monotonic() < deadline:
            line = port.readline().decode(errors='replace')
            if not line:
                continue
            log.write(line)
            log.flush()
            # Native SDK lines may contain identifiers; output only our fixed
            # application diagnostics, and keep full serial evidence private.
            if 'v3trial:' in line or 'V3 START ACCEPTED' in line:
                print(line.strip(), flush=True)
            if 'phase=V3 TEST PASSED' in line:
                result = 'passed'
                break
            if 'phase=V3 TEST FAILED' in line or 'assert failed' in line or 'Guru Meditation' in line:
                result = 'failed'
                break
        print('Board trial result:', result, flush=True)
        return 0 if result == 'passed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, serial.SerialException, KeyError):
        raise SystemExit('Trial bootstrap failed; private values withheld')
