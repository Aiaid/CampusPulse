#!/usr/bin/env python3
"""Exercise mixed RAW/setup routing using the production cp_usb frame parser."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
usb = root.parent / "components/cp_usb"
with tempfile.TemporaryDirectory(prefix="campuspulse-usb-stream-") as temp:
    executable = Path(temp) / "usb_stream_test"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                    "-I", str(root / "main"), "-I", str(usb / "include"),
                    str(root / "main/raw_control.c"), str(root / "main/raw_usb_stream.c"),
                    str(usb / "framing.c"), str(root / "tests/usb_stream_test.c"),
                    "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
print("Mixed RAW/setup USB stream: all cases passed")
