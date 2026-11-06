"""Synthetic portable statistics tests; no network, TF, board or captured data."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]
REPO = COMPONENT.parents[2]


class StatisticsTests(unittest.TestCase):
    def test_conservation_capacity_quality_and_lifecycle(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-stats-") as directory:
            executable = Path(directory) / "fixture"
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-I", str(COMPONENT / "include"),
                "-I", str(COMPONENT.parent / "cp_vehicle/include"),
                str(COMPONENT.parent / "cp_vehicle/cp_vehicle.c"),
                str(COMPONENT / "stats.c"), str(COMPONENT / "tests/fixture.c"), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)

    def test_vehicle_actual_ad_compact_oracle_parity(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-stats-vehicle-") as directory:
            executable = Path(directory) / "fixture"
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-I", str(COMPONENT / "include"),
                "-I", str(COMPONENT.parent / "cp_vehicle/include"),
                str(COMPONENT.parent / "cp_vehicle/cp_vehicle.c"), str(COMPONENT / "stats.c"),
                str(COMPONENT / "tests/vehicle_fixture.c"), "-o", str(executable)], check=True)
            fixtures = subprocess.check_output([str(executable)], text=True)
            subprocess.run(["node", str(COMPONENT / "tests/validate-vehicle.mjs")], input=fixtures,
                text=True, cwd=REPO, check=True)


if __name__ == "__main__":
    unittest.main()
