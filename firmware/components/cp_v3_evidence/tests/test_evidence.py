"""Build pure shared C producer with sanitizers and verify actual server parity."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]
REPO = COMPONENT.parents[2]


class EvidenceTests(unittest.TestCase):
    def test_bounded_producer_and_server_validator_parity(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-evidence-") as directory:
            executable = Path(directory) / "fixture"
            crypto = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-I", str(COMPONENT / "include"),
                str(COMPONENT / "evidence.c"), str(COMPONENT / "wire.c"), str(COMPONENT / "tests/fixture.c"),
                *crypto, "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)
            fixtures = subprocess.check_output([str(executable), "fixtures"], text=True)
            subprocess.run(["node", str(COMPONENT / "tests/validate.mjs")], input=fixtures,
                text=True, cwd=REPO, check=True)


if __name__ == "__main__":
    unittest.main()
