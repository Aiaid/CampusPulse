"""Exercise actual asynchronous local writer, failure latches and CPRAW decoder."""
from pathlib import Path
import importlib.util
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT.parent
spec = importlib.util.spec_from_file_location("cpraw_decoder", FIRMWARE / "waveshare-raw/tools/decode.py")
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)

class LocalRawTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="local-raw-host-")
        cls.binary = Path(cls.directory.name) / "local-raw"
        subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-D_POSIX_C_SOURCE=200809L", "-D_DEFAULT_SOURCE",
            "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-pthread",
            "-I", str(ROOT / "localtests/stubs"), "-I", str(ROOT / "main"),
            "-I", str(FIRMWARE / "waveshare-raw/main"), "-I", str(FIRMWARE / "components/cp_v3_stats/include"),
            "-I", str(FIRMWARE / "components/cp_v3_temporal/include"),
            str(ROOT / "localtests/local_raw_test.c"), str(ROOT / "localtests/host_runtime.c"),
            str(FIRMWARE / "waveshare-raw/main/raw_format.c"), "-o", str(cls.binary)], check=True)
    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()
    def run_case(self, case):
        with tempfile.TemporaryDirectory(prefix="local-raw-case-") as temp:
            root = Path(temp)
            old = root / "cpraw"
            old.mkdir()
            (old / "preserve.bin").write_bytes(b"untouched historical bytes")
            target = root / "cpraw-v3"
            subprocess.run([str(self.binary), str(target), case], check=True)
            self.assertEqual((old / "preserve.bin").read_bytes(), b"untouched historical bytes")
            return [(path.name, path.read_bytes()) for path in sorted(target.glob("*.bin"))]
    def test_normal_rotation_restart_metadata_clock(self):
        files = self.run_case("normal")
        records = []
        anchors = []
        for _, data in files:
            self.assertLessEqual(len(data), 2048)
            result = decoder.decode(data, True)
            self.assertIsNone(result["truncated_offset"])
            records.extend(record for record in result["records"] if "seq" in record)
            if result["last_anchor"]:
                anchors.append(result["last_anchor"])
        self.assertEqual([r["seq"] for r in records], [111,333,444,555])
        self.assertEqual(records[0]["payload"], "020106")
        self.assertEqual(records[1]["payload"], bytes((i*11)&255 for i in range(1650)).hex())
        self.assertEqual(records[1]["kind"], 1)
        self.assertEqual(records[1]["rssi"], -128)
        self.assertEqual(records[1]["data_status"], 2)
        self.assertEqual(records[1]["sid"], 15)
        self.assertEqual(records[1]["primary_phy"], 3)
        self.assertEqual(records[1]["secondary_phy"], 2)
        self.assertEqual(len(anchors), 1)
        self.assertEqual(anchors[0]["uncertainty_us"],1123000)
        self.assertEqual(anchors[0]["source"],2)
    def test_backpressure_and_stop_timeout(self): self.run_case("overflow")
    def test_existing_managed_quota(self): self.run_case("quota")
    def test_existing_invalid_file_preserved(self): self.run_case("invalid_file")
    def test_free_space_reserve(self): self.run_case("space")
    def test_invalid_metadata_not_truncated(self): self.run_case("invalid_report")
    def test_probe_inactive_and_existing_preserved(self):
        self.assertEqual(self.run_case("probe_normal"), [])
        files = self.run_case("probe_existing")
        self.assertEqual(len(files),1)
        self.assertEqual(len(files[0][1]),32)
        self.assertEqual(decoder.decode(files[0][1])["reports"],0)
    def test_probe_metadata_writability_retry(self):
        for case in ("probe_metadata","probe_writable"):
            with self.subTest(case=case): self.run_case(case)
    def test_probe_owned_io_failure_latches(self):
        for case in ("probe_partial","probe_fsync","probe_close","probe_media","probe_unlink"):
            with self.subTest(case=case): self.run_case(case)
    def test_budget_denial_never_creates_unpaid_file(self):
        for case in ("budget_probe","budget_probe_cleanup","budget_existing"):
            with self.subTest(case=case): self.run_case(case)
    def test_budget_midwriter_denial_prepaid_close(self):
        files=self.run_case("budget_mid")
        self.assertEqual(sum(decoder.decode(data)["reports"] for _,data in files),1)
    def test_budget_close_needs_no_fresh_credit(self): self.run_case("budget_stop")
    def test_budget_periodic_sync_denial_prepaid_close(self): self.run_case("budget_sync")
    def test_closed_crc_verify_is_read_only(self): self.run_case("verify_valid")
    def test_closed_crc_verify_rejects_corruption(self): self.run_case("verify_crc")
    def test_closed_crc_verify_rejects_short_read(self): self.run_case("verify_short")
    def test_io_failure_latches(self):
        for case in ("partial","fsync","close","media","space_io"):
            with self.subTest(case=case): self.run_case(case)

if __name__ == "__main__": unittest.main()
