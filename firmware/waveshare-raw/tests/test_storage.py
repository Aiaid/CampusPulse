"""Fault tests for the production POSIX storage implementation on the host."""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class StorageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.build.name) / 'storage_test'
        subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror',
                        '-I', str(ROOT / 'tests/storage_stubs'), '-I', str(ROOT / 'main'),
                        str(ROOT / 'tests/storage_host.c'), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def run_case(self, case):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run([str(self.binary), root, case], check=True)

    def test_exclusive_segments_and_unmount(self):
        self.run_case('segments')

    def test_short_write_latches(self):
        self.run_case('write')

    def test_no_space_latches(self):
        self.run_case('full')

    def test_flush_latches(self):
        self.run_case('flush')

    def test_no_space_during_flush_latches(self):
        self.run_case('flush_full')

    def test_sync_latches(self):
        self.run_case('sync')

    def test_close_latches(self):
        self.run_case('close')


if __name__ == '__main__':
    unittest.main()
