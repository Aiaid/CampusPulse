"""Synthetic acceptance/rejection checks; never uses hardware or existing builds."""
from __future__ import annotations

import json
from pathlib import Path
import struct
import tempfile
import unittest

from verify_images import verify

ROOT = Path(__file__).resolve().parent


def partition(label: str, typ: int, sub: int, offset: int, size: int) -> bytes:
    return struct.pack("<HBBII16sI", 0x50AA, typ, sub, offset, size,
                       label.encode().ljust(16, b"\0"), 0)


def image(chip: int = 9, flash: int = 4) -> bytes:
    header = bytearray(24)
    header[0] = 0xE9
    header[3] = flash << 4
    struct.pack_into("<H", header, 12, chip)
    return bytes(header)


class ImageChecks(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="campuspulse-s3-check-")
        self.build = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.files = {"0x0": "boot.bin", "0x8000": "partitions.bin", "0x10000": "app.bin"}
        self.write_args()
        (self.build / "boot.bin").write_bytes(image())
        (self.build / "app.bin").write_bytes(image())
        self.entries = [
            ("nvs", 1, 2, 0x9000, 0x6000),
            ("phy_init", 1, 1, 0xF000, 0x1000),
            ("factory", 0, 0, 0x10000, 0x300000),
            ("cpqueue", 1, 0x40, 0x360000, 0x400000),
        ]
        self.write_partitions()
        defaults = (ROOT / "sdkconfig.defaults").read_text()
        (self.build / "sdkconfig").write_text(defaults +
            "\nCONFIG_MQTT_TRANSPORT_SSL=y\nCONFIG_LOG_MAXIMUM_LEVEL=3\n")
        self.description = {"target": "esp32s3", "build_components": ["cp_board"],
                            "build_component_paths": [str(ROOT / "components/cp_board")]}
        self.write_description()

    def write_args(self) -> None:
        (self.build / "flasher_args.json").write_text(json.dumps({"flash_files": self.files}))

    def write_partitions(self) -> None:
        (self.build / "partitions.bin").write_bytes(
            b"".join(partition(*entry) for entry in self.entries) + b"\xff" * 32)

    def write_description(self) -> None:
        (self.build / "project_description.json").write_text(json.dumps(self.description))

    def test_valid_active_s3_separate_images(self) -> None:
        self.assertEqual(verify(self.build)["target"], "esp32s3")

    def test_wrong_chip_or_flash(self) -> None:
        for chip, flash in [(5, 4), (9, 3)]:
            with self.subTest(chip=chip, flash=flash):
                (self.build / "app.bin").write_bytes(image(chip, flash))
                with self.assertRaises(ValueError):
                    verify(self.build)

    def test_merged_or_additional_image(self) -> None:
        self.files["0x360000"] = "merged.bin"
        self.write_args()
        with self.assertRaisesRegex(ValueError, "Only separate"):
            verify(self.build)

    def test_image_path_escape(self) -> None:
        self.files["0x10000"] = "../outside.bin"
        self.write_args()
        with self.assertRaisesRegex(ValueError, "escapes"):
            verify(self.build)

    def test_wrong_queue_or_nvs_geometry(self) -> None:
        original = self.entries.copy()
        for index, change in [(3, ("cpqueue", 1, 0x40, 0x370000, 0x400000)),
                              (0, ("nvs", 1, 2, 0x9000, 0x5000))]:
            with self.subTest(partition=index):
                self.entries = original.copy()
                self.entries[index] = change
                self.write_partitions()
                with self.assertRaisesRegex(ValueError, "geometry"):
                    verify(self.build)

    def test_partition_overlap(self) -> None:
        self.entries[3] = ("cpqueue", 1, 0x40, 0x300000, 0x400000)
        self.write_partitions()
        with self.assertRaisesRegex(ValueError, "Overlapping"):
            verify(self.build)

    def test_application_size_limit(self) -> None:
        (self.build / "app.bin").write_bytes(image() + b"\0" * 0x300000)
        with self.assertRaisesRegex(ValueError, "boundary"):
            verify(self.build)

    def test_wrong_board_override(self) -> None:
        self.description["build_component_paths"] = [str(ROOT.parent / "components/cp_board")]
        self.write_description()
        with self.assertRaisesRegex(ValueError, "override"):
            verify(self.build)

    def test_passport_ui_excluded(self) -> None:
        self.description["build_components"].append("cp_ui_passport")
        self.description["build_component_paths"].append("unused")
        self.write_description()
        with self.assertRaisesRegex(ValueError, "Passport UI"):
            verify(self.build)

    def test_sdk_wireless_manager_excluded(self) -> None:
        self.description["build_components"].append("wifi_provisioning")
        self.description["build_component_paths"].append("unused")
        self.write_description()
        with self.assertRaisesRegex(ValueError, "SDK wireless provisioning"):
            verify(self.build)

    def test_insecure_config(self) -> None:
        with (self.build / "sdkconfig").open("a") as stream:
            stream.write("CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y\n")
        with self.assertRaisesRegex(ValueError, "incompatible"):
            verify(self.build)

    def test_native_tls_required(self) -> None:
        path = self.build / "sdkconfig"
        path.write_text(path.read_text().replace("CONFIG_CP_NETWORK_MQTT_NATIVE_TLS=y", ""))
        with self.assertRaisesRegex(ValueError, "Required configuration"):
            verify(self.build)

    def test_current_boot_preference_required(self) -> None:
        path = self.build / "sdkconfig"
        path.write_text(path.read_text().replace("CONFIG_CP_UPLOAD_PREFER_CURRENT_BOOT=y", ""))
        with self.assertRaisesRegex(ValueError, "CP_UPLOAD_PREFER_CURRENT_BOOT"):
            verify(self.build)

    def test_psram_512_trial_configuration_required(self) -> None:
        path = self.build / "sdkconfig"
        original = path.read_text()
        for old, new in [
            ("CONFIG_CP_PIPELINE_PSRAM_BANKS=y", "CONFIG_CP_PIPELINE_PSRAM_BANKS=n"),
            ("CONFIG_CP_COLLECT_MAX_ADDRESSES=512", "CONFIG_CP_COLLECT_MAX_ADDRESSES=128"),
            ("CONFIG_CP_NETWORK_MAX_BATCH_ITEMS=64", "CONFIG_CP_NETWORK_MAX_BATCH_ITEMS=16"),
        ]:
            with self.subTest(setting=old):
                path.write_text(original.replace(old, new))
                with self.assertRaises(ValueError):
                    verify(self.build)

    def test_usb_only_required_and_security2_disabled(self) -> None:
        path = self.build / "sdkconfig"
        original = path.read_text()
        for old, new in [
            ("CONFIG_CP_PROVISION_USB_ONLY=y", "CONFIG_CP_PROVISION_USB_ONLY=n"),
            ("CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2=n",
             "CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2=y"),
        ]:
            with self.subTest(setting=old):
                path.write_text(original.replace(old, new))
                with self.assertRaises(ValueError):
                    verify(self.build)

    def test_tls_record_bounds_and_ownership(self) -> None:
        path = self.build / "sdkconfig"
        original = path.read_text()
        for old, new in [
            ("CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=16384", "CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=4096"),
            ("CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=4096", "CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=1024"),
            ("CONFIG_MBEDTLS_DYNAMIC_FREE_CA_CERT=n", "CONFIG_MBEDTLS_DYNAMIC_FREE_CA_CERT=y"),
            ("CONFIG_LOG_MAXIMUM_LEVEL=3", "CONFIG_LOG_MAXIMUM_LEVEL=4"),
        ]:
            with self.subTest(setting=old):
                path.write_text(original.replace(old, new))
                with self.assertRaises(ValueError):
                    verify(self.build)


if __name__ == "__main__":
    unittest.main()
