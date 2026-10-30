"""Exercise production export with real POSIX files under temporary roots only."""
import ctypes
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
OK, FAIL, ARG, STATE = 0, -1, 0x102, 0x103
MAX_SIZE = 16 * 1024 * 1024 + 2 * 1728
NAME = '0123456789abcdef0123456789abcdef-00000000.bin'

HOST_SOURCE = r'''
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "raw_board.h"
static char root[2048];
static int fault, mounts, unmounts, directories, files;
void host_root(const char *path) {
    if (snprintf(root, sizeof(root), "%s", path) >= (int)sizeof(root)) abort();
    mounts = unmounts = directories = files = fault = 0;
}
void host_fault(int value) { fault = value; }
int host_count(int kind) {
    return kind == 0 ? mounts : kind == 1 ? unmounts : kind == 2 ? directories : files;
}
static const char *host_path(const char *path) {
    static char mapped[4096];
    if (strncmp(path, "/sdcard/cpraw", 13) || (path[13] && path[13] != '/')) abort();
    if (snprintf(mapped, sizeof(mapped), "%s%s", root, path + 7) >= (int)sizeof(mapped)) abort();
    return mapped;
}
esp_err_t raw_storage_mount(void) {
    ++mounts; return fault == 1 || fault == 12 ? ESP_FAIL : ESP_OK;
}
esp_err_t raw_storage_unmount(void) {
    ++unmounts; return fault == 2 || fault == 12 ? ESP_FAIL : ESP_OK;
}
static DIR *host_opendir(const char *path) {
    DIR *result = opendir(host_path(path)); if (result) ++directories; return result;
}
static struct dirent *host_readdir(DIR *dir) {
    if (fault == 3) { errno = EIO; return NULL; } return readdir(dir);
}
static int host_closedir(DIR *dir) {
    --directories; int result = closedir(dir); return fault == 4 ? -1 : result;
}
static int host_stat(const char *path, struct stat *st) {
    if (fault == 5) return -1;
    return stat(host_path(path), st);
}
static FILE *host_fopen(const char *path, const char *mode) {
    if (strcmp(mode, "rb")) abort();
    if (fault == 6) return NULL;
    FILE *result = fopen(host_path(path), mode); if (result) ++files; return result;
}
static int host_fclose(FILE *file) {
    --files; int result = fclose(file); return fault == 7 ? EOF : result;
}
static int host_fstat(int fd, struct stat *st) { return fault == 8 ? -1 : fstat(fd, st); }
static int host_fseek(FILE *file, long offset, int origin) {
    return fault == 9 ? -1 : fseek(file, offset, origin);
}
static size_t host_fread(void *data, size_t size, size_t count, FILE *file) {
    return fread(data, size, fault == 10 && count > 2 ? 2 : count, file);
}
static int host_ferror(FILE *file) { return fault == 11 ? 1 : ferror(file); }
#define opendir host_opendir
#define readdir host_readdir
#define closedir host_closedir
#define stat(path, st) host_stat(path, st)
#define fopen host_fopen
#define fclose host_fclose
#define fstat host_fstat
#define fseek host_fseek
#define fread host_fread
#define ferror host_ferror
#include "raw_export.c"
'''


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix='raw-export-build-')
        source = Path(cls.build.name) / 'host.c'
        source.write_text(HOST_SOURCE)
        binary = Path(cls.build.name) / 'export.so'
        subprocess.run([os.environ.get('CC', 'cc'), '-std=c11',
                        '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror',
                        '-fPIC', '-shared', '-I', str(ROOT / 'tests/storage_stubs'),
                        '-I', str(ROOT / 'main'), str(source), '-o', str(binary)], check=True)
        cls.lib = ctypes.CDLL(str(binary))
        cls.lib.host_root.argtypes = [ctypes.c_char_p]
        cls.lib.host_fault.argtypes = [ctypes.c_int]
        cls.lib.host_count.argtypes = [ctypes.c_int]
        cls.lib.raw_export_count.restype = ctypes.c_size_t
        cls.lib.raw_export_truncated.restype = ctypes.c_bool
        cls.lib.raw_export_size.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_uint32)]
        cls.lib.raw_export_read.argtypes = [ctypes.c_uint, ctypes.c_uint32, ctypes.c_void_p,
                                            ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        cls.lib.raw_export_crc32.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        cls.lib.raw_export_crc32.restype = ctypes.c_uint32

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.lib.host_fault(0)
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.temp = tempfile.TemporaryDirectory(prefix='raw-export-card-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.card = self.root / 'cpraw'
        self.card.mkdir()
        self.lib.host_root(os.fsencode(self.root))

    def tearDown(self):
        self.lib.host_fault(0)
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.assertEqual(self.lib.host_count(2), 0)
        self.assertEqual(self.lib.host_count(3), 0)

    def put(self, name=NAME, data=b'0123456789'):
        file = self.card / name
        file.write_bytes(data)
        return file

    def size(self, index):
        size = ctypes.c_uint32(123)
        result = self.lib.raw_export_size(index, ctypes.byref(size))
        return result, size.value

    def read(self, index, offset, cap=512):
        buffer = ctypes.create_string_buffer(max(cap, 1))
        length = ctypes.c_size_t(999)
        result = self.lib.raw_export_read(index, offset, buffer, cap, ctypes.byref(length))
        return result, buffer.raw[:length.value], length.value

    def snapshot(self):
        return {file.name: (file.stat().st_size, file.stat().st_mtime_ns,
                            hashlib.sha256(file.read_bytes()).digest())
                for file in self.card.iterdir() if file.is_file()}

    def test_filter_and_sorted_stable_index_without_modification(self):
        self.put()
        self.put('f' * 32 + '-99999999.bin', b'last')
        self.put('A' * 32 + '-00000002.bin', b'upper')
        for name in ('not-raw.bin', NAME + '.bak', 'd' * 32 + '-00000000.BIN',
                     'g' * 32 + '-00000000.bin', '0' * 31 + '-00000000.bin',
                     '0' * 32 + '-0000000.bin', '0' * 32 + '-0000000x.bin'):
            self.put(name, b'ignored')
        (self.card / ('b' * 32 + '-00000000.bin')).mkdir()
        before = self.snapshot()
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        self.assertEqual(self.lib.raw_export_count(), 3)
        self.assertFalse(self.lib.raw_export_truncated())
        self.assertEqual([self.read(i, 0)[1] for i in range(3)],
                         [b'0123456789', b'upper', b'last'])
        self.assertEqual(self.lib.raw_export_prepare(), STATE)
        self.assertEqual(self.size(0), (OK, 10))
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.lib.host_count(1), 1)
        self.assertEqual(self.lib.raw_export_count(), 0)
        self.assertFalse(self.lib.raw_export_truncated())

    def test_random_offsets_eof_bounds_and_invalid_arguments(self):
        content = bytes(range(256)) * 5
        self.put(data=content)
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        for offset, cap in ((512, 512), (0, 512), (1279, 512), (1, 7), (1280, 512), (0, 0)):
            self.assertEqual(self.read(0, offset, cap),
                             (OK, content[offset:offset + cap], len(content[offset:offset + cap])))
        self.assertEqual(self.read(0, 1281)[0], ARG)
        self.assertEqual(self.read(0, 0xffffffff)[0], ARG)
        self.assertEqual(self.read(1, 0)[0], ARG)
        self.assertEqual(self.read(0, 0, 513)[0], ARG)
        self.assertEqual(self.size(1), (ARG, 0))
        self.assertEqual(self.lib.raw_export_size(0, None), ARG)
        length = ctypes.c_size_t(99)
        self.assertEqual(self.lib.raw_export_read(0, 0, None, 1, ctypes.byref(length)), ARG)
        self.assertEqual(length.value, 0)
        self.assertEqual(self.lib.raw_export_read(0, 0, None, 0, ctypes.byref(length)), OK)
        self.assertEqual(self.lib.raw_export_read(0, 0, None, 0, None), ARG)
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.assertEqual(self.size(0), (STATE, 0))
        self.assertEqual(self.read(0, 0)[0], STATE)

    def test_empty_file_and_empty_directory(self):
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        self.assertEqual(self.lib.raw_export_count(), 0)
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.put(data=b'')
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        self.assertEqual(self.size(0), (OK, 0))
        self.assertEqual(self.read(0, 0), (OK, b'', 0))

    def test_manifest_limit_and_truncation(self):
        for i in range(128):
            self.put(f'{i:032x}-00000000.bin', b'x')
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        self.assertEqual(self.lib.raw_export_count(), 128)
        self.assertFalse(self.lib.raw_export_truncated())
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.put('f' * 32 + '-00000000.bin', b'x')
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        self.assertEqual(self.lib.raw_export_count(), 128)
        self.assertTrue(self.lib.raw_export_truncated())
        self.assertEqual(self.size(128), (ARG, 0))

    def test_file_length_bound_and_uint32_overflow(self):
        file = self.put(data=b'')
        for size in (MAX_SIZE, MAX_SIZE + 1, (1 << 32) + 1):
            with file.open('r+b') as stream:
                stream.truncate(size)
            result = self.lib.raw_export_prepare()
            self.assertEqual(result, OK if size == MAX_SIZE else FAIL)
            if result == OK:
                self.assertEqual(self.size(0), (OK, size))
                self.assertEqual(self.read(0, size), (OK, b'', 0))
            else:
                self.assertEqual(self.lib.raw_export_count(), 0)
            self.assertEqual(self.lib.raw_export_close(), OK)

    def test_length_change_and_missing_file_fail_closed(self):
        file = self.put()
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        file.write_bytes(b'changed')
        self.assertEqual(self.size(0), (FAIL, 0))
        self.assertEqual(self.read(0, 0), (FAIL, b'', 0))
        file.unlink()
        self.assertEqual(self.size(0), (FAIL, 0))
        self.assertEqual(self.read(0, 0), (FAIL, b'', 0))

    def test_prepare_faults_release_and_allow_safe_close(self):
        self.put()
        for fault in (1, 3, 4, 5):
            self.lib.host_fault(fault)
            self.assertEqual(self.lib.raw_export_prepare(), FAIL)
            self.assertEqual(self.lib.raw_export_count(), 0)
            self.assertEqual(self.lib.host_count(2), 0)
            self.assertEqual(self.lib.raw_export_close(), OK)
        self.lib.host_fault(0)
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        self.lib.host_fault(2)
        self.assertEqual(self.lib.raw_export_close(), FAIL)
        self.assertEqual(self.lib.raw_export_prepare(), STATE)
        self.assertEqual(self.lib.raw_export_count(), 0)
        self.lib.host_fault(0)
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.assertEqual(self.lib.raw_export_prepare(), OK)

    def test_missing_directory_does_not_create_it(self):
        self.card.rmdir()
        self.assertEqual(self.lib.raw_export_prepare(), FAIL)
        self.assertFalse(self.card.exists())
        self.assertEqual(self.lib.host_count(1), 1)
        self.assertEqual(self.lib.raw_export_close(), OK)

    def test_partial_mount_and_failed_cleanup_can_be_retried(self):
        self.lib.host_fault(12)
        self.assertEqual(self.lib.raw_export_prepare(), FAIL)
        self.assertEqual(self.lib.host_count(1), 1)
        self.assertEqual(self.lib.raw_export_close(), FAIL)
        self.assertEqual(self.lib.raw_export_prepare(), STATE)
        self.lib.host_fault(0)
        self.assertEqual(self.lib.raw_export_close(), OK)
        self.assertEqual(self.lib.raw_export_prepare(), OK)

    def test_read_faults_close_handles_and_normal_short_read(self):
        self.put()
        self.assertEqual(self.lib.raw_export_prepare(), OK)
        for fault in (6, 7, 8, 9, 11):
            self.lib.host_fault(fault)
            self.assertEqual(self.read(0, 0), (FAIL, b'', 0))
            self.assertEqual(self.lib.host_count(3), 0)
        self.lib.host_fault(10)
        self.assertEqual(self.read(0, 0), (OK, b'01', 2))
        self.lib.host_fault(0)
        self.assertEqual(self.read(0, 7), (OK, b'789', 3))

    def test_crc_matches_zlib(self):
        for data in (b'', b'123456789', bytes(range(256)) * 4, b'\x00' * 512):
            buffer = ctypes.create_string_buffer(data)
            self.assertEqual(self.lib.raw_export_crc32(buffer, len(data)), zlib.crc32(data))
        self.assertEqual(self.lib.raw_export_crc32(None, 0), 0)


if __name__ == '__main__':
    unittest.main()
