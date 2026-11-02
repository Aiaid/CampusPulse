"""Synthetic codec/NVS fault tests, no device or production credentials."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]
SETTINGS = COMPONENT.parent / "cp_settings"


class StartupTests(unittest.TestCase):
    def test_codec_and_nvs_faults(self):
        if prefix := os.environ.get("CP_TEST_OPENSSL"):
            openssl = Path(prefix)
            crypto_flags = ["-I", str(openssl / "include"), "-L", str(openssl / "lib"), "-lcrypto"]
        else:
            crypto_flags = shlex.split(subprocess.check_output(
                ["pkg-config", "--cflags", "--libs", "openssl"], text=True))
        with tempfile.TemporaryDirectory(prefix="cp-startup-test-") as directory:
            output = Path(directory) / "fixture"
            subprocess.run([
                os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I", str(COMPONENT / "include"), "-I", str(COMPONENT / "tests/host"),
                "-I", str(SETTINGS / "include"), "-I", str(SETTINGS / "tests/host"),
                *crypto_flags,
                str(COMPONENT / "profile.c"), str(COMPONENT / "startup_nvs.c"),
                str(SETTINGS / "settings_validate.c"), str(COMPONENT / "tests/host_crypto.c"),
                str(COMPONENT / "tests/fixture.c"), "-o", str(output),
            ], check=True)
            subprocess.run([str(output)], check=True)


if __name__ == "__main__":
    unittest.main()
