"""Run production orchestration with deterministic IDF/NimBLE shims only."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]


class CaptureTests(unittest.TestCase):
    def test_orchestration(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-capture-") as directory:
            includes = []
            for item in [COMPONENT / "include", COMPONENT / "tests/stubs",
                COMPONENT.parent / "cp_v3_stats/include", COMPONENT.parent / "cp_v3_temporal/include",
                COMPONENT.parent / "cp_v3_evidence/include"]:
                includes += ["-I", str(item)]
            executable = Path(directory) / "fixture"
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", *includes,
                str(COMPONENT / "tests/fixture.c"), str(COMPONENT.parent / "cp_v3_stats/stats.c"),
                str(COMPONENT.parent / "cp_v3_temporal/temporal.c"), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
