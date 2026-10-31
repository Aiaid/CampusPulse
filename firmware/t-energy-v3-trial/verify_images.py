"""Check the T-Energy development build against its existing Flash geometry."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import struct


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def verify(build: Path) -> dict:
    build = build.resolve()
    existing = Path(__file__).resolve().parent.parent / "t-energy-s3" / "verify_images.py"
    spec = importlib.util.spec_from_file_location("te_existing_layout", existing)
    require(spec is not None and spec.loader is not None, "Existing layout verifier missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = set((build / "sdkconfig").read_text().splitlines())
    for option in ("ESPTOOLPY_FLASHSIZE_16MB", "ESPTOOLPY_FLASHMODE_QIO", "SPIRAM",
                   "SPIRAM_MODE_OCT", "ESP_CONSOLE_USB_SERIAL_JTAG"):
        require(f"CONFIG_{option}=y" in config, f"Missing configuration: {option}")
    require('CONFIG_IDF_TARGET="esp32s3"' in config, "Wrong target")
    description = json.loads((build / "project_description.json").read_text())
    require(description["target"] == "esp32s3", "Wrong build target")
    args = json.loads((build / "flasher_args.json").read_text())
    # ESP-IDF 5.5.3 deliberately boots QIO configurations in DIO and switches
    # to quad mode during bootloader initialization (esptool_py/Kconfig.projbuild).
    require(args["write_flash_args"] == ["--flash_mode", "dio", "--flash_size", "16MB",
                                         "--flash_freq", "80m"], "Unexpected flash options")
    files = {int(offset, 0): name for offset, name in args["flash_files"].items()}
    require(set(files) == {0, 0x8000, 0x10000}, "Unexpected image offsets")
    report = {"target": "esp32s3", "images": {}}
    for offset, name in files.items():
        path = (build / name).resolve()
        require(path.is_relative_to(build), "Image outside build directory")
        data = path.read_bytes()
        require(data and offset + len(data) <= {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[offset],
                "Image crosses its reserved range")
        if offset == 0x8000:
            module.verify_partitions(data)
            entries = data[:4 * 32]
            require(all(struct.unpack_from("<I", entries, n * 32 + 28)[0] == 0
                        for n in range(4)), "Existing partition flags changed")
            checksum = data[4 * 32:5 * 32]
            require(len(checksum) == 32 and checksum[:16] == b"\xeb\xeb" + b"\xff" * 14
                    and checksum[16:] == hashlib.md5(entries).digest(),
                    "Partition table checksum missing or invalid")
        else:
            require(len(data) >= 24 and data[0] == 0xE9 and data[2] == 2 and data[3] >> 4 == 4,
                    "Invalid image or Flash size")
            require(struct.unpack_from("<H", data, 12)[0] == 9, "Image is not ESP32-S3")
        report["images"][name] = {"offset": hex(offset), "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()}
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    print(json.dumps(verify(parser.parse_args().build), indent=2))
