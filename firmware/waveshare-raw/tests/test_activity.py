import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main"
TEST = ROOT / "tests" / "activity_test.c"


class RawActivityHostTests(unittest.TestCase):
    def test_compiled_c_activity_module(self):
        with tempfile.TemporaryDirectory(prefix="raw-activity-") as temp_dir:
            executable = Path(temp_dir) / "activity_test"
            compiler = os.environ.get("CC", "cc")
            subprocess.run(
                [
                    compiler,
                    "-std=c11",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-pedantic",
                    "-I",
                    str(MAIN),
                    str(TEST),
                    str(MAIN / "raw_activity.c"),
                    "-o",
                    str(executable),
                ],
                check=True,
                cwd=ROOT,
            )
            result = subprocess.run(
                [str(executable)], check=True, capture_output=True, text=True
            )
            self.assertIn("raw activity host tests passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
