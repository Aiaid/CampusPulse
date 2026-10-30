#!/usr/bin/env python3
"""Compile and exercise the same allocation-free parser used by the firmware."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="campuspulse-control-") as temp:
    executable = Path(temp) / "control_test"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(root / "main"), str(root / "main/raw_control.c"),
                    str(root / "tests/control_test.c"), "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
print("STOP stream parser: all cases passed")
