import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main"
TEST = ROOT / "tests" / "refresh_test.c"


class RawRefreshHostTests(unittest.TestCase):
    def test_compiled_c_refresh_module(self):
        with tempfile.TemporaryDirectory(prefix="raw-refresh-") as temp_dir:
            executable = Path(temp_dir) / "refresh_test"
            subprocess.run(
                [
                    os.environ.get("CC", "cc"),
                    "-std=c11",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-pedantic",
                    "-I",
                    str(MAIN),
                    str(TEST),
                    str(MAIN / "raw_refresh.c"),
                    "-o",
                    str(executable),
                ],
                check=True,
                cwd=ROOT,
            )
            result = subprocess.run(
                [str(executable)], check=True, capture_output=True, text=True
            )
            self.assertIn("raw refresh host tests passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
