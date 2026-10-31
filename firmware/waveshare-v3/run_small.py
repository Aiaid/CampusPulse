#!/usr/bin/env python3
"""Physical USB bootstrap; native MQTT/TLS production, explicit isolated HTTPS."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid
import serial

# Matches CP_API_ORIGIN in cp_settings.h; the host regression checks the binding.
PRODUCTION_ORIGIN = 'https://pulse.anend.net'
PRODUCTION_HOST = PRODUCTION_ORIGIN.removeprefix('https://')
MQTT_URI = 'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883'
MQTT_KEYS = ('mqtt_uri', 'mqtt_username', 'mqtt_password', 'mqtt_namespace')
LAN_NETS = tuple(ipaddress.IPv4Network(value) for value in
                 ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def validate_backend(backend, *, allow_public_test=False, allow_production=False):
    """Pure origin/trust preflight; runs before opening a physical serial port."""
    if type(allow_public_test) is not bool or type(allow_production) is not bool:
        raise ValueError('origin permission must be explicit')
    origin = backend.get('endpoint')
    if not isinstance(origin, str) or len(origin) > 127:
        raise ValueError('invalid HTTPS origin')
    match = re.fullmatch(r'https://([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?', origin)
    if not match or (match[2] and int(match[2]) > 65535):
        raise ValueError('invalid HTTPS origin')
    host = match[1]
    ca_fields = any(key.startswith('server_ca_') for key in backend)
    production_host = host == PRODUCTION_HOST or host.endswith('.' + PRODUCTION_HOST)
    transport = backend.get('uplink_transport', 'mqtt_tls')
    if transport not in ('mqtt_tls', 'https'):
        raise ValueError('unsupported uplink transport')
    if production_host:
        if not allow_production or origin != PRODUCTION_ORIGIN:
            raise ValueError('canonical production origin requires --allow-production')
        if backend.get('tls') != 'public_ca_bundle' or ca_fields:
            raise ValueError('production requires the system CA bundle without test CA fields')
        if transport != 'mqtt_tls':
            raise ValueError('production requires native MQTT/TLS without HTTPS fallback')
        if backend.get('mqtt_uri') != MQTT_URI:
            raise ValueError('fixed production MQTT broker required')
        for key, bound in (('mqtt_username', 64), ('mqtt_password', 96)):
            value = backend.get(key)
            if not isinstance(value, str) or not 1 <= len(value) <= bound or any(not 33 <= ord(c) <= 126 for c in value):
                raise ValueError('private MQTT credentials required')
        if not isinstance(backend.get('mqtt_namespace'), str) or not re.fullmatch(r'[a-z0-9_-]{1,15}', backend['mqtt_namespace']):
            raise ValueError('invalid MQTT namespace')
        return origin
    if transport != 'https' or any(key in backend for key in MQTT_KEYS):
        raise ValueError('isolated diagnostics require explicit HTTPS without MQTT fields')
    if allow_public_test:
        if backend.get('tls') != 'public_ca_bundle' or ca_fields:
            raise ValueError('public test requires the system CA bundle without test CA fields')
        if re.fullmatch(r'[0-9.]+', host):
            address = ipaddress.IPv4Address(host)
            if not address.is_global or address.is_multicast or address.is_reserved:
                raise ValueError('invalid public IPv4 test origin')
        else:
            labels = host.split('.')
            if (len(labels) < 2 or not re.fullmatch(r'[a-z][a-z0-9-]*', labels[-1])
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                           for label in labels)):
                raise ValueError('invalid public DNS test origin')
    else:
        address = ipaddress.IPv4Address(host)
        if not any(address in network for network in LAN_NETS):
            raise ValueError('LAN origin or an explicit origin permission required')
    return origin


def read_private(path):
    s = path.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077:
        raise ValueError('private input permissions required')
    return json.loads(path.read_text())


def hello(port, log):
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
            if not line.startswith('V3 HELLO '):
                continue
            candidate = json.loads(line[9:])
            if candidate.get('request_id') == request_id:
                return (candidate, sent_wall, sent_mono,
                        time.time_ns() // 1_000_000,
                        time.monotonic_ns() // 1_000_000)
    raise ValueError('physical HELLO timeout')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', required=True)
    p.add_argument('--private-dir', type=Path, required=True)
    p.add_argument('--windows', type=int, choices=range(0, 61), default=3)
    p.add_argument('--timeout', type=int, default=900)
    p.add_argument('--allow-public-test', action='store_true',
                   help='permit isolated public HTTPS with the system CA bundle')
    p.add_argument('--allow-production', action='store_true',
                   help='explicitly permit only canonical CP_API_ORIGIN with the system CA bundle')
    args = p.parse_args()
    directory = args.private_dir.resolve()
    os.chmod(directory, 0o700)
    backend = read_private(directory / 'backend-bootstrap.json')
    wifi = read_private(directory / 'wifi.json')
    validate_backend(backend, allow_public_test=args.allow_public_test,
                     allow_production=args.allow_production)
    port = serial.Serial(port=None, baudrate=115200, timeout=.2)
    port.dtr = False
    port.rts = False
    port.port = args.port
    port.open()
    logfd = os.open(directory / 'board-small-serial.log', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with port, os.fdopen(logfd, 'w') as log:
        for boot_attempt in range(2):
            identity, sent_wall, sent_mono, received_wall, received_mono = hello(port, log)
            if identity['node_id'] != backend['node_id']:
                raise ValueError('actual board identity did not match private credential')
            if not identity.get('restart_required'):
                break
            if boot_attempt:
                raise ValueError('board still requires restart')
            port.write(b'RESTART\n')
            port.flush()
            port.close()
            time.sleep(.3)
            reopen_until = time.monotonic() + 5
            while True:
                try:
                    port.open()
                    break
                except serial.SerialException:
                    if time.monotonic() >= reopen_until:
                        raise
                    time.sleep(.1)
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
                         uplink_transport=backend.get('uplink_transport', 'mqtt_tls'),
                         origin=backend['endpoint'], device_token=backend['device_bearer'],
                         ssid=wifi['ssid'], password=wifi['password'], security='personal',
                         utc_ms=(sent_wall + received_wall) // 2,
                         uncertainty_ms=(rtt + 1) // 2 + 251,
                         anchor_mono_ms=identity['mono_ms'],
                         max_windows=args.windows)
        if bootstrap['uplink_transport'] == 'mqtt_tls':
            bootstrap.update({key: backend[key] for key in MQTT_KEYS})
        ca = backend.get('server_ca_pem')
        if ca is not None:
            if not isinstance(ca, str) or len(ca.encode('ascii')) > 4096 or 'PRIVATE KEY' in ca or '-----BEGIN CERTIFICATE-----' not in ca or '-----END CERTIFICATE-----' not in ca:
                raise ValueError('invalid explicit test CA')
            bootstrap['server_ca_pem'] = ca
        frame = bytearray(('V3START ' + json.dumps(bootstrap, separators=(',', ':')) + '\n').encode('ascii'))
        if len(frame) >= 8192:
            raise ValueError('bootstrap byte bound exceeded')
        port.write(frame)
        port.flush()
        frame[:] = b'\0' * len(frame)
        bootstrap.clear()
        print('Physical bootstrap sent; waiting for board-owned v3 requests', flush=True)
        deadline = time.monotonic() + args.timeout
        result = 'timeout'
        while time.monotonic() < deadline:
            line = port.readline().decode(errors='replace')
            if not line:
                continue
            log.write(line)
            log.flush()
            # Native SDK lines may contain identifiers; output only our fixed
            # application diagnostics, and keep full serial evidence private.
            if 'v3small:' in line or 'V3 START ACCEPTED' in line:
                print(line.strip(), flush=True)
            if 'phase=SMALL TEST PASSED' in line:
                result = 'passed'
                break
            if 'phase=SMALL STOPPED ERROR' in line or 'assert failed' in line or 'Guru Meditation' in line:
                result = 'failed'
                break
        print('Board small-results result:', result, flush=True)
        return 0 if result == 'passed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, serial.SerialException, KeyError):
        raise SystemExit('Trial bootstrap failed; private values withheld')
