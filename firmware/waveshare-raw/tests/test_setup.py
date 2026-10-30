"""Compile the v2 adapter lifecycle against actual settings validation and sanitizers."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = ROOT.parent / "components/cp_settings"


class SetupTests(unittest.TestCase):
    def test_lifecycle(self):
        with tempfile.TemporaryDirectory(prefix="campuspulse-setup-") as directory:
            binary = Path(directory) / "setup_test"
            subprocess.run([
                os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I", str(ROOT / "main"), "-I", str(SETTINGS / "include"),
                "-I", str(SETTINGS / "tests/host"), str(ROOT / "main/raw_setup.c"),
                str(SETTINGS / "settings_validate.c"), str(ROOT / "tests/setup_test.c"),
                "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
