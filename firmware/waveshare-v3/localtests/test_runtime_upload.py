"""Pure queue scheduling checks, with no storage, network or board operations."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class UploadScheduling(unittest.TestCase):
    def test_identity_scoped_retry_fairness_and_boot_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "upload"
            subprocess.run([
                "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I" + str(ROOT / "firmware/waveshare-v3/main"),
                "-I" + str(ROOT / "firmware/components/cp_v3_queue/include"),
                "-I" + str(ROOT / "firmware/components/cp_v3_evidence/include"),
                str(ROOT / "firmware/waveshare-v3/localtests/runtime_upload_test.c"),
                "-o", str(binary),
            ], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
