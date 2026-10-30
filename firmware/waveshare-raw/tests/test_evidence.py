"""Synthetic CPRAW evidence, conservation, integrity and privacy regression tests."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("extract_evidence", ROOT / "tools/extract_evidence.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def with_crc(data):
    return data + struct.pack("<I", zlib.crc32(data))


HEADER = with_crc(tool.decoder.MAGIC + struct.pack("<HH", 1, 32) + b"private-session!")


def frame(typ, body):
    return with_crc(struct.pack("<IB3x", 12 + len(body), typ) + body)


def report(payload=b"", *, seq=1, addr=b"secret", addr_type=1, kind=0, status=0):
    body = (struct.pack("<QQHH", seq, seq * 100, len(payload), 0) + addr +
            bytes([addr_type, kind, 4, 0, status, 255, 1, 0, 0]) +
            b"direct" + struct.pack("<bb", -60, 127) + payload)
    return frame(1, body)


def ad(typ, data):
    return bytes([1 + len(data), typ]) + data


def lookup(result, kind, value, source=None):
    return next(row for row in result["evidence"] if row["kind"] == kind and
                row["value"] == value and (source is None or row.get("source") == source))


class EvidenceTests(unittest.TestCase):
    def test_endian_roles_and_private_fields_never_emitted(self):
        uuid128 = bytes(range(16))
        payload = (ad(0xff, b"\x4c\x00private-manufacturer") +
                   ad(9, b"private-name") + ad(3, b"\x0f\x18") +
                   ad(0x16, b"\x0f\x18private-service") +
                   ad(0x1f, b"\x78\x56\x34\x12") +
                   ad(0x19, b"\x40\x00") + ad(7, uuid128) +
                   ad(0x21, uuid128 + b"individual") + b"\0\0")
        result = tool.extract(HEADER + report(payload))
        self.assertEqual(lookup(result, "company_id", "0x004c")["reports"], 1)
        self.assertEqual(lookup(result, "appearance", "0x0040")["occurrences"], 1)
        self.assertEqual(lookup(result, "service_uuid", "0x180f", "complete_list")["width_bits"], 16)
        self.assertEqual(lookup(result, "service_uuid", "0x180f", "service_data")["reports"], 1)
        self.assertEqual(lookup(result, "service_uuid", "0x12345678", "solicitation")["width_bits"], 32)
        self.assertEqual(lookup(result, "service_uuid", "redacted", "complete_list")["width_bits"], 128)
        encoded = json.dumps(result)
        for private in ("private-session", "private-name", "private-manufacturer", "private-service",
                        "individual", b"secret".hex(), b"direct".hex(), uuid128.hex(), payload.hex()):
            self.assertNotIn(private, encoded)
        self.assertEqual(result["classification"]["status"], "not_run")
        self.assertIsNone(result["classification"]["estimated_total"])

    def test_report_and_address_conservation_no_cross_address_merging(self):
        payload = ad(0xff, b"\x20\x00") * 2
        data = HEADER + report(payload) + report(payload, seq=2) + report(payload, seq=3, addr=b"other!")
        data += report(payload, seq=4, addr_type=0)
        result = tool.extract(data)
        self.assertEqual(result["units"], {"reports": 4, "address_type_keys": 3})
        self.assertEqual(sum(result["quality"]["report_partition"].values()), 4)
        self.assertEqual(result["classification"]["unknown_address_type_keys"], 3)
        company = lookup(result, "company_id", "0x0020")
        self.assertEqual((company["occurrences"], company["reports"], company["address_type_keys"]), (8, 4, 3))

    def test_fragment_truncated_and_unknown_statuses_never_supply_ad_evidence(self):
        payload = ad(0xff, b"\x4c\0")
        data = HEADER + report(payload, kind=1)
        for seq, (kind, status) in enumerate(((1, 1), (1, 2), (1, 3), (0, 1)), 2):
            data += report(payload, seq=seq, kind=kind, status=status)
        result = tool.extract(data)
        self.assertEqual(result["quality"]["report_partition"], {
            "complete_valid_ad": 1, "extended_fragment_more": 1,
            "extended_truncated": 1, "extended_unknown_status": 1,
            "legacy_unexpected_status": 1})
        self.assertEqual(lookup(result, "company_id", "0x004c")["reports"], 1)

    def test_malformed_report_does_not_salvage_valid_prefix(self):
        valid_prefix = ad(0xff, b"\x4c\0")
        malformed = (b"\x05\xff\x4c", ad(0xff, b"x"), ad(0x19, b"x"),
                     ad(3, b"x"), ad(0x16, b"x"), b"\0nonzero")
        for suffix in malformed:
            with self.subTest(suffix=suffix):
                result = tool.extract(HEADER + report(valid_prefix + suffix))
                self.assertEqual(result["quality"]["report_partition"], {"complete_malformed_ad": 1})
                self.assertEqual(result["evidence"], [])

    def test_empty_data_and_zero_padding_are_valid_unknown(self):
        empty = tool.extract(HEADER)
        self.assertEqual(empty["units"], {"reports": 0, "address_type_keys": 0})
        self.assertEqual(empty["quality"]["report_partition"], {})
        result = tool.extract(HEADER + report() + report(b"\0\0", seq=2))
        self.assertEqual(result["quality"]["report_partition"], {"complete_valid_ad": 2})
        self.assertEqual(result["evidence"], [])

    def test_extended_payload_keeps_evidence_beyond_legacy_boundary(self):
        payload = ad(9, b"n" * 40) + ad(5, b"\x78\x56\x34\x12") + ad(0x19, b"\x40\0")
        result = tool.extract(HEADER + report(payload, kind=1))
        self.assertEqual(lookup(result, "appearance", "0x0040")["reports"], 1)
        self.assertEqual(lookup(result, "service_uuid", "0x12345678", "complete_list")["width_bits"], 32)
        # Different long service UUIDs collapse without leaking either value.
        payload = ad(7, bytes(range(16)) + bytes(range(16, 32)))
        row = lookup(tool.extract(HEADER + report(payload, kind=1)),
                     "service_uuid", "redacted", "complete_list")
        self.assertEqual((row["occurrences"], row["reports"]), (2, 1))

    def test_existing_decoder_rejects_crc_and_preserves_interrupted_tail(self):
        complete = HEADER + report(ad(1, b"\x06"))
        data = complete + report(seq=2)[:-2]
        result = tool.extract(data)
        self.assertEqual(result["units"]["reports"], 1)
        self.assertEqual(result["quality"]["truncated_offset"], len(complete))
        broken = bytearray(complete)
        broken[-1] ^= 1
        with self.assertRaises(tool.decoder.FormatError):
            tool.extract(broken)
        # A corrupt middle length cannot masquerade as an interrupted tail.
        broken = bytearray(HEADER + report() + report(seq=2))
        struct.pack_into("<I", broken, 32, 1728)
        with self.assertRaisesRegex(tool.decoder.FormatError, "later valid frame"):
            tool.extract(broken)

    def test_sequence_gaps_stats_and_nonreport_frames(self):
        data = HEADER + report(seq=4) + report(seq=7) + report(seq=7) + report(seq=2)
        data += frame(2, struct.pack("<7Q", 1000, 10, 8, 2, 0, 7, 6))
        data += frame(3, struct.pack("<QIi", 1000, 7, -9))
        data += frame(4, struct.pack("<QQIB", 1000, 1700000000, 50, 1))
        quality = tool.extract(data)["quality"]
        self.assertEqual(quality["sequence"], {"forward_missing": 2,
                                               "duplicates": 1, "regressions": 1})
        self.assertEqual(quality["last_stats"]["queue_drops"], 2)
        self.assertNotIn("mono_us", quality["last_stats"])
        self.assertEqual((quality["stats_frames"], quality["event_frames"], quality["anchor_frames"]), (1, 1, 1))

    def test_bounds_fail_closed_including_cli_no_partial_output(self):
        data = HEADER + report(ad(1, b"\x06")) + report(ad(9, b"private-name"), seq=2, addr=b"other!")
        for kwargs in ({"max_bytes": len(data) - 1}, {"max_addresses": 1},
                       {"max_features": 1}, {"max_address_features": 1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(tool.CapacityError):
                tool.extract(data, **kwargs)
        for kwargs in ({"max_bytes": 0}, {"max_features": 4097}, {"max_addresses": 65537},
                       {"max_address_features": 262145}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                tool.extract(data, **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-placement.raw"
            path.write_bytes(data)
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = tool.main([str(path), "--max-addresses", "1"])
            self.assertEqual(code, 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertNotIn(str(path), stderr.getvalue())
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(tool.main([str(path)]), 0)
            self.assertEqual(json.loads(stdout.getvalue())["units"]["reports"], 2)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(tool.main(["/private/tmp/nonexistent-private-placement-cpraw"]), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("private-placement", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
