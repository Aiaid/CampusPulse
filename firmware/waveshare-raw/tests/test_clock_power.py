#!/usr/bin/env python3
"""Compile production RTC/power modules against fault-injecting C host drivers."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ClockPowerTests(unittest.TestCase):
    def compile_and_run(self, name):
        with tempfile.TemporaryDirectory(prefix="campuspulse-clock-power-") as temp:
            executable = Path(temp) / name
            subprocess.run([
                os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I", str(ROOT / "tests/clock_power_stubs"), "-I", str(ROOT / "main"),
                str(ROOT / "tests" / f"{name}.c"), "-o", str(executable),
            ], check=True)
            subprocess.run([str(executable)], check=True)

    def test_clock(self):
        self.compile_and_run("clock_test")

    def test_power(self):
        self.compile_and_run("power_test")


if __name__ == "__main__":
    unittest.main()
