"""Verify active T-Energy-S3 separate images, layout and resolved configuration."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify_partitions(data: bytes) -> dict[str, tuple[int, int, int, int]]:
    partitions = {}
    regions = []
    for start in range(0, len(data), 32):
        entry = data[start:start + 32]
        if entry[:2] in (b"\xff\xff", b"\xeb\xeb"):
            break
        require(len(entry) == 32 and entry[:2] == b"\xaa\x50", "Invalid partition entry")
        _, typ, sub, offset, size, raw_label, _ = struct.unpack("<HBBII16sI", entry)
        label = raw_label.rstrip(b"\0").decode("ascii")
        require(label not in partitions, "Duplicate partition label")
        require(size > 0 and offset >= 0x9000 and offset + size <= 0x1000000,
                "Partition outside available 16 MB Flash")
        require(all(offset + size <= lo or offset >= hi for lo, hi in regions),
                "Overlapping partitions")
        partitions[label] = (typ, sub, offset, size)
        regions.append((offset, offset + size))
    require(partitions == {
        "nvs": (1, 2, 0x9000, 0x6000),
        "phy_init": (1, 1, 0xF000, 0x1000),
        "factory": (0, 0, 0x10000, 0x300000),
        "cpqueue": (1, 0x40, 0x360000, 0x400000),
    }, "Active S3 partition geometry changed")
    return partitions


def verify_config(build: Path) -> None:
    lines = set((build / "sdkconfig").read_text().splitlines())
    for key in (
        "ESPTOOLPY_FLASHSIZE_16MB", "ESPTOOLPY_FLASHMODE_QIO",
        "SPIRAM", "SPIRAM_MODE_OCT", "ESP_CONSOLE_USB_SERIAL_JTAG", "CP_PIPELINE_PSRAM_BANKS",
        "CP_NETWORK_MQTT_WSS", "CP_NETWORK_MQTT_NATIVE_TLS",
        "MQTT_TRANSPORT_SSL", "MBEDTLS_CERTIFICATE_BUNDLE",
        "MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL", "MBEDTLS_HAVE_TIME",
        "MBEDTLS_HAVE_TIME_DATE", "MBEDTLS_DYNAMIC_BUFFER", "ESP_HTTP_CLIENT_ENABLE_HTTPS",
        "CP_PROVISION_USB_ONLY",
        "CP_UPLOAD_PREFER_CURRENT_BOOT",
    ):
        require(f"CONFIG_{key}=y" in lines, f"Required configuration missing: {key}")
    for key in (
        "CP_PASSPORT_DISPLAY", "CP_PASSPORT_BUTTONS", "CP_LEGACY_RADAR_DIAGNOSTICS",
        "CP_PERF_PROFILE", "ESPTOOLPY_HEADER_FLASHSIZE_UPDATE", "ESP_TLS_INSECURE",
        "ESP_TLS_SKIP_SERVER_CERT_VERIFY", "ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_0",
        "ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_1", "MQTT_TRANSPORT_WEBSOCKET",
        "ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2",
        "MQTT_TRANSPORT_WEBSOCKET_SECURE",
        "MBEDTLS_DYNAMIC_FREE_CONFIG_DATA", "MBEDTLS_DYNAMIC_FREE_CA_CERT",
        "MBEDTLS_SSL_KEEP_PEER_CERTIFICATE",
    ):
        require(f"CONFIG_{key}=y" not in lines, f"Unsafe/incompatible configuration: {key}")
    require('CONFIG_IDF_TARGET="esp32s3"' in lines, "Configuration is not ESP32-S3")
    require("CONFIG_FREERTOS_HZ=1000" in lines, "Shared chain requires a 1 ms tick")
    require("CONFIG_CP_COLLECT_MAX_ADDRESSES=512" in lines,
            "S3 trial requires the explicit 512-address collector ceiling")
    require("CONFIG_CP_NETWORK_MAX_BATCH_ITEMS=64" in lines,
            "S3 trial requires the bounded 64-item upload ceiling")
    require("CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=16384" in lines,
            "TLS incoming record bound changed")
    require("CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=4096" in lines,
            "TLS outgoing record bound changed")
    require("CONFIG_LOG_MAXIMUM_LEVEL=3" in lines, "SDK DEBUG logs must stay disabled")
    description = json.loads((build / "project_description.json").read_text())
    require(description["target"] == "esp32s3", "Resolved build target is not ESP32-S3")
    components = dict(zip(description["build_components"], description["build_component_paths"]))
    require("cp_ui_passport" not in components, "Passport UI must not be linked")
    require("wifi_provisioning" not in components,
            "SDK wireless provisioning manager must be excluded from the USB-only build")
    require("cp_board" in components, "Board adapter missing")
    expected = Path(__file__).resolve().parent / "components/cp_board"
    require(Path(components["cp_board"]).resolve() == expected,
            "Resolved board adapter is not the project-local S3 override")


def verify(build: Path) -> dict:
    build = build.resolve()
    verify_config(build)
    args = json.loads((build / "flasher_args.json").read_text())
    files = {int(offset, 0): name for offset, name in args["flash_files"].items()}
    require(set(files) == {0, 0x8000, 0x10000},
            "Only separate bootloader, partition and application images are permitted")
    report = {"target": "esp32s3", "images": {}}
    for offset, name in files.items():
        path = (build / name).resolve()
        require(path.is_relative_to(build), "Image path escapes build directory")
        data = path.read_bytes()
        limit = {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[offset]
        require(data and offset + len(data) <= limit, "Image crosses its partition boundary")
        if offset == 0x8000:
            verify_partitions(data)
        else:
            require(len(data) >= 24 and data[0] == 0xE9, "Invalid ESP image header")
            require(data[3] >> 4 == 4, "Image must declare 16 MB Flash")
            require(struct.unpack_from("<H", data, 12)[0] == 9,
                    "Image target must be ESP32-S3")
        report["images"][name] = {
            "offset": hex(offset), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    print(json.dumps(verify(parser.parse_args().build), indent=2))
