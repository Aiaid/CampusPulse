"""Admission regression for USB setup with an idle observer-only host."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = r'''
#include "raw_setup_radio.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
    const raw_setup_radio_state_t idle = {
        .writer_done = true, .storage_safe = true, .stop_requested = true,
    };
    assert(raw_setup_radio_admit(NULL) == ESP_ERR_INVALID_ARG);
    assert(raw_setup_radio_admit(&idle) == ESP_OK);
    /* A completed write count alone is insufficient: flush/unmount must pass. */
    raw_setup_radio_state_t state = idle;
    state.storage_safe = false;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    state = idle; state.writer_done = false;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    state = idle; state.stop_requested = false;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    /* Idle-looking GAP state cannot hide an in-flight callback or producer. */
    state = idle; state.callbacks = 1;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    state.callbacks = UINT32_MAX;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    state = idle; state.accepting_reports = true;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    state = idle; state.scanning = true;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    state = idle; state.power_requested = true;
    assert(raw_setup_radio_admit(&state) == ESP_ERR_INVALID_STATE);
    /* Repeated admission is observational and does not alter radio state. */
    for (unsigned i = 0; i < 100; ++i) assert(raw_setup_radio_admit(&idle) == ESP_OK);
    puts("Idle-host admission: storage, producer, GAP, callback and power gates passed");
    return 0;
}
'''


class RadioAdmissionTests(unittest.TestCase):
    def test_idle_host_admission(self):
        with tempfile.TemporaryDirectory(prefix="campuspulse-idle-host-") as directory:
            source = Path(directory) / "radio.c"
            binary = Path(directory) / "radio"
            source.write_text(SOURCE)
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I", str(ROOT / "main"), "-I", str(ROOT.parent / "components/cp_settings/tests/host"),
                str(source), str(ROOT / "main/raw_setup_radio.c"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
