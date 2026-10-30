#!/usr/bin/env python3
"""Exercise the SSD1681 command stream through a pure host-side IO trace."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="campuspulse-panel-") as directory:
    exe = Path(directory) / "panel-test"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(root / "main"), str(root / "main/raw_panel.c"),
                    str(root / "tests/panel_test.c"), "-o", str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
print("SSD1681 full/partial/off command traces passed")
