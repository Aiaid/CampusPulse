"""Compile exact compact production serializers with sanitizers and server parity."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]
REPO = COMPONENT.parents[2]


class SmallResultsTests(unittest.TestCase):
    def test_compact_wire_and_actual_server_validators(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-small-wire-") as directory:
            executable = Path(directory) / "fixture"
            crypto = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
            includes = []
            for name in ["cp_v3_small_results", "cp_v3_stats", "cp_v3_temporal", "cp_v3_evidence"]:
                includes += ["-I", str(COMPONENT.parent / name / "include")]
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", *includes,
                str(COMPONENT / "wire.c"), str(COMPONENT / "tests/fixture.c"), *crypto, "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)
            fixtures = subprocess.check_output([str(executable), "fixtures"], text=True)
            subprocess.run(["node", str(COMPONENT / "tests/validate.mjs")], input=fixtures, text=True, cwd=REPO, check=True)


if __name__ == "__main__":
    unittest.main()
