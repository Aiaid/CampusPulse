"""Compile portable production queue/TF adapter; use synthetic temp files only."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]
REPO = COMPONENT.parents[2]
EVIDENCE = COMPONENT.parent / "cp_v3_evidence"
BOARD = REPO / "firmware/waveshare-raw/main"


class QueueTests(unittest.TestCase):
    def test_sd_mapping_status_and_sync_failure(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-sd-sync-") as directory:
            root = Path(directory)
            (root / "ff.h").write_text("#pragma once\ntypedef unsigned char BYTE;\n#define FF_VOLUMES 2\n")
            (root / "sdmmc_cmd.h").write_text("#pragma once\ntypedef struct {int test;} sdmmc_card_t;\n#define ESP_OK 0\nint sdmmc_get_status(sdmmc_card_t*);\n")
            (root / "diskio.h").write_text("#pragma once\n#define CTRL_SYNC 0\n#define RES_OK 0\nint disk_ioctl(BYTE,BYTE,void*);\n")
            (root / "diskio_sdmmc.h").write_text("#pragma once\n#include \"sdmmc_cmd.h\"\nBYTE ff_diskio_get_pdrv_card(const sdmmc_card_t*);\n")
            (root / "test.c").write_text(r'''
#include "raw_v3_queue_sd_sync.h"
#include "ff.h"
#include "sdmmc_cmd.h"
#include <assert.h>
#include <stddef.h>
static unsigned drive, status, fail, calls;
BYTE ff_diskio_get_pdrv_card(const sdmmc_card_t *c) { assert(c); return drive; }
int sdmmc_get_status(sdmmc_card_t *c) { assert(c); return status; }
int disk_ioctl(BYTE d,BYTE command,void *buffer) { assert(d==drive&&command==0&&!buffer); ++calls; return fail; }
int main(void) {
    sdmmc_card_t card={0};
    assert(!raw_v3_queue_sd_sync(NULL)); drive=0xff; assert(!raw_v3_queue_sd_sync(&card));
    drive=2; assert(!raw_v3_queue_sd_sync(&card)); drive=1; status=1;
    assert(!raw_v3_queue_sd_sync(&card)&&!calls); status=0; fail=1;
    assert(!raw_v3_queue_sd_sync(&card)&&calls==1); fail=0;
    assert(raw_v3_queue_sd_sync(&card)&&calls==2); return 0;
}
''')
            executable = root / "test"
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-I", directory, "-I", str(BOARD),
                str(BOARD / "raw_v3_queue_sd_sync.c"), str(root / "test.c"), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)

    def test_failures_and_files(self):
        with tempfile.TemporaryDirectory(prefix="cp-v3-queue-") as directory:
            executable = Path(directory) / "fixture"
            crypto = shlex.split(subprocess.check_output(
                ["pkg-config", "--cflags", "--libs", "openssl"], text=True))
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-D_POSIX_C_SOURCE=200809L",
                "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I", str(COMPONENT / "include"), "-I", str(EVIDENCE / "include"), "-I", str(BOARD),
                str(COMPONENT / "queue.c"), str(EVIDENCE / "wire.c"), str(EVIDENCE / "evidence.c"),
                str(BOARD / "raw_v3_queue_store.c"), str(COMPONENT / "tests/fixture.c"),
                *crypto, "-o", str(executable)], check=True)
            subprocess.run([str(executable), directory], check=True)


if __name__ == "__main__":
    unittest.main()
