"""Portable budget replay; synthetic memory store, no device/NVS/network access."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]


class BudgetTests(unittest.TestCase):
    def test_reboots_and_uncertain_commits(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-budget-") as directory:
            executable = Path(directory) / "budget-test"
            subprocess.run([
                os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g",
                "-I", str(COMPONENT / "include"), str(COMPONENT / "budget.c"),
                str(COMPONENT / "tests/fixture.c"), "-o", str(executable),
            ], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
