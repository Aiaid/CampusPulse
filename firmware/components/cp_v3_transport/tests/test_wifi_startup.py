"""Sanitized actual owner-loop test with virtual Wi-Fi/time; no radio/network."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class WifiStartup(unittest.TestCase):
    def test_owner_loop(self):
        source = Path(__file__).with_name("wifi_startup_test.c")
        with tempfile.TemporaryDirectory(prefix="v3-wifi-startup-") as folder:
            binary = Path(folder) / "test"
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-fsanitize=address,undefined", str(source), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
