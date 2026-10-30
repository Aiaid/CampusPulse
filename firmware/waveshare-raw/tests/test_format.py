import importlib.util
import subprocess
import tempfile
import struct
import zlib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('decode', ROOT / 'tools/decode.py')
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)

C_SOURCE = r'''
#include "raw_format.h"
#include <stdio.h>
#include <string.h>
int main(void) {
    uint8_t buf[RAW_FRAME_MAX], session[16] = {1, 2};
    raw_report_t r = {0};
    r.seq = 0x102030405060708ULL; r.mono_us = 99; r.length = RAW_PAYLOAD_MAX;
    r.periodic_interval = 0x1234; r.addr[0] = 0xab; r.kind = 1;
    r.event_type = 3; r.props = 4; r.data_status = 2; r.sid = 15;
    r.primary_phy = 1; r.secondary_phy = 2; r.direct_addr[0] = 0xcd;
    r.rssi = -72; r.tx_power = -4;
    for (unsigned i = 0; i < RAW_PAYLOAD_MAX; i++) r.payload[i] = (uint8_t)i;
    if (raw_encode_header(buf, RAW_HEADER_SIZE - 1, session)) return 1;
    size_t n = raw_encode_header(buf, sizeof buf, session); fwrite(buf, 1, n, stdout);
    if (raw_encode_report(buf, 10, &r)) return 2;
    n = raw_encode_report(buf, sizeof buf, &r); if (!n) return 3; fwrite(buf, 1, n, stdout);
    r.length = RAW_PAYLOAD_MAX + 1; if (raw_encode_report(buf, sizeof buf, &r)) return 4;
    if (raw_encode_clock(buf, 32, 456, 1700000000, 750000, RAW_CLOCK_RTC)) return 7;
    if (raw_encode_clock(buf, sizeof buf, 456, 1700000000, 750000, 0)) return 8;
    n = raw_encode_clock(buf, sizeof buf, 456, 1700000000, 750000,
                         RAW_CLOCK_HOST_CALIBRATED_RTC);
    if (n != 33) return 9;
    fwrite(buf, 1, n, stdout);
    n = raw_encode_stats(buf, sizeof buf, 8, 10, 9, 1, 2, 7, 6);
    fwrite(buf, 1, n, stdout);
    if (raw_encode_event(buf, 27, 123, RAW_EVENT_BLE_RESET, -12345)) return 5;
    n = raw_encode_event(buf, sizeof buf, 123, RAW_EVENT_BLE_RESET, -12345);
    if (n != 28) return 6;
    fwrite(buf, 1, n, stdout); return 0;
}
'''


class FormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / 'fixture.c'
            binary = Path(td) / 'fixture'
            src.write_text(C_SOURCE)
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(ROOT / 'main'),
                            str(src), str(ROOT / 'main/raw_format.c'), '-o', str(binary)], check=True)
            cls.data = subprocess.check_output([str(binary)])

    def test_roundtrip_and_default_privacy(self):
        summary = decoder.decode(self.data)
        self.assertEqual(summary['reports'], 1)
        self.assertEqual(summary['stats_frames'], 1)
        self.assertEqual(summary['last_stats']['queue_drops'], 1)
        self.assertEqual(summary['anchor_frames'], 1)
        self.assertEqual(summary['last_anchor'], {'mono_us': 456, 'utc_epoch_seconds': 1700000000,
                                                  'uncertainty_us': 750000, 'source': 2})
        self.assertEqual(decoder.decode(self.data, True)['records'][1],
                         {'type': 'clock_anchor', **summary['last_anchor']})
        self.assertEqual(summary['event_frames'], 1)
        self.assertEqual(summary['last_event'], {'mono_us': 123, 'event': 6, 'detail': -12345})
        self.assertEqual(decoder.decode(self.data, True)['records'][-1],
                         {'type': 'event', 'mono_us': 123, 'event': 6, 'detail': -12345})
        self.assertNotIn('records', summary)
        self.assertNotIn('session', summary)
        record = decoder.decode(self.data, True)['records'][0]
        self.assertEqual(record['seq'], 0x102030405060708)
        self.assertEqual(record['periodic_interval'], 0x1234)
        self.assertEqual(record['data_status'], 2)
        self.assertEqual(record['rssi'], -72)
        self.assertEqual(record['addr'], 'ab0000000000')
        self.assertEqual(len(bytes.fromhex(record['payload'])), 1650)

    def test_crc_corruption_is_error(self):
        broken = bytearray(self.data)
        broken[100] ^= 1
        with self.assertRaisesRegex(decoder.FormatError, 'CRC mismatch at offset 32'):
            decoder.decode(broken)

    def test_corrupt_middle_length_before_valid_frame(self):
        broken = bytearray(self.data[:-236] + self.data[-96:])
        # Make the report claim a frame that extends past EOF.
        broken[32:36] = (1728).to_bytes(4, 'little')
        with self.assertRaisesRegex(decoder.FormatError, 'later valid frame'):
            decoder.decode(broken)

    def test_truncated_tail_reports_frame_start(self):
        full = decoder.decode(self.data)
        stats_start = len(self.data) - 28
        for cut in (1, 3, 4, 15, 27):
            summary = decoder.decode(self.data[:-cut])
            self.assertEqual(summary['truncated_offset'], stats_start)
            self.assertEqual(summary['valid_bytes'], stats_start)
        self.assertIsNone(full['truncated_offset'])

    def test_event_crc_and_short_body(self):
        event_start = len(self.data) - 28
        broken = bytearray(self.data)
        broken[event_start + 20] ^= 1
        with self.assertRaisesRegex(decoder.FormatError, 'CRC mismatch'):
            decoder.decode(broken)
        # Complete, CRC-valid frame with a too-short event body must still fail.
        frame = struct.pack('<IB3xQ', 24, 3, 123) + b'\0' * 4
        frame += struct.pack('<I', zlib.crc32(frame))
        with self.assertRaisesRegex(decoder.FormatError, 'invalid event'):
            decoder.decode(self.data[:event_start] + frame)

    def test_clock_crc_short_source_and_old_file(self):
        anchor_start = len(self.data) - 96 - 33
        old_data = self.data[:anchor_start] + self.data[anchor_start + 33:]
        old = decoder.decode(old_data)
        self.assertEqual(old['anchor_frames'], 0)
        self.assertIsNone(old['last_anchor'])
        self.assertEqual(old['reports'], 1)
        self.assertEqual(old['event_frames'], 1)
        broken = bytearray(self.data)
        broken[anchor_start + 16] ^= 1
        with self.assertRaisesRegex(decoder.FormatError, 'CRC mismatch'):
            decoder.decode(broken)
        frame = struct.pack('<IB3xQQI', 32, 4, 456, 1700000000, 750000)
        frame += struct.pack('<I', zlib.crc32(frame))
        with self.assertRaisesRegex(decoder.FormatError, 'invalid clock anchor'):
            decoder.decode(self.data[:anchor_start] + frame)
        broken = bytearray(self.data)
        broken[anchor_start + 28] = 3
        struct.pack_into('<I', broken, anchor_start + 29,
                         zlib.crc32(broken[anchor_start:anchor_start + 29]))
        with self.assertRaisesRegex(decoder.FormatError, 'invalid clock source'):
            decoder.decode(broken)
        broken[anchor_start + 5] = 1
        struct.pack_into('<I', broken, anchor_start + 29,
                         zlib.crc32(broken[anchor_start:anchor_start + 29]))
        with self.assertRaisesRegex(decoder.FormatError, 'nonzero reserved bytes'):
            decoder.decode(broken)

    def test_bad_length_and_header(self):
        broken = bytearray(self.data)
        broken[32:36] = (1729).to_bytes(4, 'little')
        with self.assertRaisesRegex(decoder.FormatError, 'invalid frame length'):
            decoder.decode(broken)
        with self.assertRaisesRegex(decoder.FormatError, 'incomplete file header'):
            decoder.decode(self.data[:31])


if __name__ == '__main__':
    unittest.main()
