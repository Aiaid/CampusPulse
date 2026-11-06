"""Synthetic CPRAW fixtures exercise the actual portable C statistics core."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('cpraw_replay', ROOT / 'scripts/prepare-v3-cpraw-replay.py')
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)


def header(session=b'0123456789abcdef'):
    value = b'CPRAW\r\n\x1a' + struct.pack('<HH', 1, 32) + session
    return value + struct.pack('<I', zlib.crc32(value))


def frame(kind, body):
    value = struct.pack('<IB3x', 12 + len(body), kind) + body
    return value + struct.pack('<I', zlib.crc32(value))


def report(seq, mono, address=b'\xaa\xbb\xcc\xdd\xee\xff', *, kind=0, event=0, props=0,
           status=0, rssi=-60, payload=b'\x02\x01\x06'):
    body = struct.pack('<QQHH', seq, mono, len(payload), 0) + address
    body += bytes((1, kind, event, props, status, 0, 1, 0, 0))
    body += b'\0' * 6 + struct.pack('<bb', rssi, 127) + payload
    return frame(1, body)


def event(mono, code):
    return frame(3, struct.pack('<QIi', mono, code, 0))


def stats(mono, count=0, drops=0):
    return frame(2, struct.pack('<7Q', mono, count + drops, count, drops, 0, count, count))


class ReplayTests(unittest.TestCase):
    def test_complete_source_retains_submillisecond_first_report_and_partial_tail(self):
        source = self.source(event(100000, 1), report(1, 218713), report(2, 60218713),
                             report(3, 67245678), event(67255611, 8), stats(67255617, 3))
        result = replay.prepare([source], window_ms=60000, all_reports=True)
        self.assertEqual(result['provenance']['replayed_reports'], 3)
        self.assertTrue(result['provenance']['complete_source'])
        self.assertEqual(sum(w['item']['r'][1] for w in result['windows']), 3)
        first, last = result['windows']
        self.assertEqual(first['source_start_mono_us'], 218000)
        self.assertEqual(first['item']['r'][1], 1)
        self.assertEqual(last['source_end_mono_us'], 67256000)
        self.assertEqual(last['item']['d'], 7038)
        self.assertTrue(last['item']['f'] & 1)
        self.assertEqual(len(last['item']['x']), 2)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cpraw-replay-test-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'synthetic.cpraw'

    def source(self, *parts):
        self.path.write_bytes(header() + b''.join(parts))
        return self.path

    def test_real_core_conservation_and_private_aggregate_output(self):
        source = self.source(event(900000, 1), report(1, 1000000),
            report(2, 1200000, event=4), report(4, 1800000, payload=b'\x05\xff\x01'),
            report(5, 2000000, address=b'123456', kind=1, props=8, status=1),
            report(6, 2400000, address=b'654321', rssi=127), stats(3000000, 5, 2))
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        value = replay.prepare([source], windows=2)
        self.assertEqual(value['schema'], 'campuspulse-cpraw-replay/1')
        one, two = [window['item'] for window in value['windows']]
        self.assertEqual(one['c'], [0, 0, 0, 0, 1, 0])
        self.assertEqual(one['r'], [3, 3, 2, 1])
        self.assertEqual(one['x'], [[3, 1, 3, -180]])
        self.assertEqual(one['l'], [1000, 0, 0, 0])
        self.assertEqual(one['f'], 0)
        self.assertEqual(two['c'], [0, 0, 0, 0, 2, 0])
        self.assertEqual(two['r'], [2, 2, 1, 1])
        self.assertEqual(two['s'], [1, -60, -60, -60])
        self.assertEqual(value['windows'][0]['diagnostics']['malformed_reports'], 1)
        self.assertEqual(value['windows'][0]['diagnostics']['forward_sequence_gaps'], 1)
        self.assertEqual(value['windows'][1]['diagnostics']['unsupported_reports'], 1)
        self.assertEqual(value['provenance']['source_capture_cumulative_last_stats']['queue_drops'], 2)
        self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())
        encoded = json.dumps(value)
        for private in ('aabbccddeeff', '313233343536', '020106', '0123456789abcdef', str(source)):
            self.assertNotIn(private, encoded)
        for window in value['windows']:
            item = window['item']
            self.assertEqual(sum(x[0] for x in item['x']), item['r'][1])
            self.assertEqual(sum(item['r'][2:]), item['r'][1])
            self.assertEqual(sum(x[2] for x in item['x']), item['s'][0])
            self.assertEqual(sum(x[3] for x in item['x']), item['s'][1])
            self.assertEqual(set(item), {'d', 'b', 'c', 'r', 'x', 's', 'l', 'f', 'v'})

    def test_unknown_and_explicit_partial_scan_coverage(self):
        self.source(report(1, 1000000), event(1500000, 1), event(1750000, 2), stats(2000000, 1))
        value = replay.prepare([self.path], windows=1)
        window = value['windows'][0]
        self.assertEqual(window['item']['l'], [250, 0, 0, 0])
        self.assertEqual(window['item']['f'], 4)
        self.assertEqual(window['diagnostics']['scan_unknown_us'], 500000)
        self.assertEqual(window['diagnostics']['scan_paused_us'], 250000)
        self.source(report(1, 1000000), event(1200000, 999), stats(2000000, 1))
        value = replay.prepare([self.path], windows=1)
        self.assertEqual(value['windows'][0]['item']['l'][0], 0)
        self.assertEqual(value['windows'][0]['item']['f'], 4)
        self.assertEqual(value['windows'][0]['diagnostics']['scan_unknown_us'], 1000000)

    def test_actual_core_address_capacity_overflow_is_flagged(self):
        self.source(event(900000, 1), *[
            report(index + 1, 1000000 + index, address=index.to_bytes(6, 'little'))
            for index in range(513)], stats(2000000, 513))
        item = replay.prepare([self.path], windows=1)['windows'][0]['item']
        self.assertEqual(item['c'], [0, 0, 0, 0, 512, 0])
        self.assertEqual(item['r'], [513, 513, 513, 0])
        self.assertEqual(item['x'], [[513, 512, 513, -30780]])
        self.assertEqual(item['l'], [1000, 0, 0, 1])
        self.assertEqual(item['f'], 8)

    def test_reconstruct_state_before_offset_and_retain_anchors(self):
        anchor = frame(4, struct.pack('<QQIB', 900000, 1790000000, 1000001, 1))
        self.source(anchor, event(900000, 1), report(1, 1000001), report(2, 2001000), stats(3001000, 2))
        value = replay.prepare([self.path], windows=1, offset_ms=1000)
        self.assertEqual(value['windows'][0]['source_start_mono_us'], 2001000)
        self.assertEqual(value['windows'][0]['item']['l'][0], 1000)
        self.assertEqual(value['windows'][0]['item']['r'][1], 1)
        self.assertEqual(value['provenance']['source_clock_anchors'][0]['uncertainty_us'], 1000001)
        self.assertNotIn('t', value['windows'][0]['item'])

    def test_multi_segment_session_and_sequences(self):
        one = self.source(event(900000, 1), report(1, 1000000))
        two = Path(self.directory.name) / 'part2.cpraw'
        two.write_bytes(header() + report(3, 2000000) + stats(3000000, 2))
        value = replay.prepare([one, two], windows=2)
        self.assertEqual(value['provenance']['source_count'], 2)
        self.assertEqual(value['provenance']['forward_sequence_gaps'], 1)
        self.assertEqual(len(value['provenance']['source_sha256']), 2)
        two.write_bytes(header(b'fedcba9876543210') + report(3, 2000000))
        with self.assertRaisesRegex(replay.ReplayError, 'sessions'):
            replay.prepare([one, two], windows=1)
        two.write_bytes(header() + report(1, 2000000))
        with self.assertRaisesRegex(replay.ReplayError, 'sequence'):
            replay.prepare([one, two], windows=1)

    def test_reject_corruption_truncation_and_regression_even_after_windows(self):
        valid = header() + report(1, 1000000) + stats(2000000, 1)
        cases = []
        damaged = bytearray(valid)
        damaged[28] ^= 1
        cases.append((bytes(damaged), 'header CRC'))
        damaged = bytearray(valid)
        damaged[-1] ^= 1
        cases.append((bytes(damaged), 'frame CRC'))
        cases.extend(((valid + b'\x40', 'truncated'), (valid + report(2, 3000000)[:-2], 'truncated'),
                      (valid + report(1, 3000000), 'sequence'),
                      (valid + report(2, 900000), 'monotonic')))
        for content, message in cases:
            with self.subTest(message=message):
                self.path.write_bytes(content)
                with self.assertRaisesRegex(replay.ReplayError, message):
                    replay.prepare([self.path], windows=1)

    def test_bound_windows_to_source_extent_and_cadences(self):
        self.source(report(1, 1000000), stats(61000000, 1))
        for duration, bins in ((1000, 1), (30000, 6), (60000, 12)):
            value = replay.prepare([self.path], window_ms=duration, windows=1)
            self.assertEqual(len(value['windows'][0]['item']['x']), bins)
        for kwargs in ({'windows': 121}, {'windows': 0}, {'window_ms': 5000}, {'offset_ms': -1}, {'windows': 61}):
            with self.subTest(kwargs=kwargs), self.assertRaises(replay.ReplayError):
                replay.prepare([self.path], **kwargs)

    def test_private_output_modes_and_source_path_protection(self):
        source = self.source(report(1, 1000000), stats(2000000, 1))
        value = replay.prepare([source], windows=1)
        captures = ROOT / 'captures'
        captures.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='synthetic-replay-test-', dir=captures) as directory:
            output = Path(directory) / 'private' / 'replay.json'
            replay.write_private(output, value, [source])
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads(output.read_text()), value)
        with self.assertRaises(replay.ReplayError):
            replay.write_private(source, value, [source])


if __name__ == '__main__':
    unittest.main()
