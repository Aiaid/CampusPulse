"""Deterministic synthetic replays; no board, network, address logs or captures."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]


class TemporalTests(unittest.TestCase):
    def test_replays_and_memory_bounds(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-temporal-") as directory:
            executable = Path(directory) / "temporal-test"
            subprocess.run([
                os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g",
                "-I", str(COMPONENT / "include"), str(COMPONENT / "temporal.c"),
                str(COMPONENT / "tests/fixture.c"), "-o", str(executable),
            ], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
