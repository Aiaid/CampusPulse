"""Synthetic image/partition guard tests; never read a physical device."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "tools" / "verify_images.py"
SPEC = importlib.util.spec_from_file_location("verify_images", MODULE)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


def partition(label, typ, sub, offset, size):
    return struct.pack("<HBBII16sI", 0x50aa, typ, sub, offset, size,
                       label.encode().ljust(16, b"\0"), 0)


def table(app_size=0x300000, cardid_offset=0x356000, cardid_subtype=2):
    return b"".join([
        partition("nvs", 1, 2, 0x9000, 0x6000),
        partition("phy_init", 1, 1, 0xf000, 0x1000),
        partition("factory", 0, 0, 0x10000, app_size),
        partition("cardid", 1, cardid_subtype, cardid_offset, 0x4000),
        b"\xff" * 32,
    ])


def image(size=24, chip=5):
    result = bytearray(size)
    result[0] = 0xe9
    result[3] = 0x30
    struct.pack_into("<H", result, 12, chip)
    return result


class ImageGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.build = Path(self.temp.name)
        (self.build / "bootloader").mkdir()
        (self.build / "partition_table").mkdir()
        self.files = {"0x0": "bootloader/bootloader.bin",
                      "0x8000": "partition_table/partition-table.bin",
                      "0x10000": "radar.bin"}
        (self.build / self.files["0x0"]).write_bytes(image())
        (self.build / self.files["0x8000"]).write_bytes(table())
        (self.build / "radar.bin").write_bytes(image())
        self.write_args()

    def write_args(self):
        (self.build / "flasher_args.json").write_text(json.dumps({"flash_files": self.files}))

    def test_valid_separate_images(self):
        report = VERIFY.verify(self.build)
        self.assertEqual(report["target"], "esp32c3")
        self.assertEqual(len(report["images"]), 3)
        self.assertEqual(len(report["images"]["radar.bin"]["sha256"]), 64)

    def test_reject_historical_oversized_partition(self):
        with self.assertRaises(ValueError):
            VERIFY.verify_partitions(table(app_size=0x7f0000))

    def test_reject_moved_or_missing_cardid(self):
        with self.assertRaises(ValueError):
            VERIFY.verify_partitions(table(cardid_offset=0x350000))
        with self.assertRaises(ValueError):
            VERIFY.verify_partitions(table()[:96] + b"\xff" * 32)

    def test_reject_cardid_as_custom_data(self):
        with self.assertRaises(ValueError):
            VERIFY.verify_partitions(table(cardid_subtype=0x40))

    def test_reject_overlap_and_flash_overflow(self):
        for offset, size in [(0x10000, 0x1000), (0x7ff000, 0x2000)]:
            with self.subTest(offset=offset):
                with self.assertRaises(ValueError):
                    VERIFY.verify_partitions(table()[:-32] + partition("extra", 1, 0x40, offset, size))

    def test_reject_oversized_app(self):
        (self.build / "radar.bin").write_bytes(image(0x300001))
        with self.assertRaises(ValueError):
            VERIFY.verify(self.build)

    def test_reject_wrong_target_or_flash_size(self):
        for bad_image in [image(chip=9), bytes([0xe9, 0, 0, 0x20]) + bytes(20)]:
            (self.build / "radar.bin").write_bytes(bad_image)
            with self.assertRaises(ValueError):
                VERIFY.verify(self.build)

    def test_reject_protected_data_flash_entry(self):
        self.files["0x356000"] = "cardid.bin"
        self.write_args()
        with self.assertRaises(ValueError):
            VERIFY.verify(self.build)

    def test_reject_path_escape(self):
        self.files["0x10000"] = "../outside.bin"
        self.write_args()
        with self.assertRaises(ValueError):
            VERIFY.verify(self.build)


if __name__ == "__main__":
    unittest.main()
