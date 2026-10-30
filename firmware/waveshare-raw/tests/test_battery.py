#!/usr/bin/env python3
"""Check calibrated battery failure paths, exact V2 ADC wiring and voltage bounds."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="campuspulse-battery-") as temp:
    executable = Path(temp) / "battery_test"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                    "-I", str(root / "tests/battery_stubs"), "-I", str(root / "main"),
                    str(root / "main/raw_battery.c"), str(root / "tests/battery_test.c"),
                    "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
print("Calibrated V2 battery measurement: all cases passed")
