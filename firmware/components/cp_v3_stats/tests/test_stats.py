"""Synthetic portable statistics tests; no network, TF, board or captured data."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]


class StatisticsTests(unittest.TestCase):
    def test_conservation_capacity_quality_and_lifecycle(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-stats-") as directory:
            executable = Path(directory) / "fixture"
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-I", str(COMPONENT / "include"),
                str(COMPONENT / "stats.c"), str(COMPONENT / "tests/fixture.c"), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
