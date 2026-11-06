"""Run actual online.c with strict HTTP doubles; run.py covers real crypto."""
from pathlib import Path
import os
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
COMPONENTS = HERE.parents[1]
with tempfile.TemporaryDirectory(prefix="cp-clock-online-") as directory:
    temp = Path(directory)
    for name in ["sdkconfig.h", "esp_crt_bundle.h", "esp_http_client.h", "esp_log.h",
                 "esp_random.h", "esp_timer.h", "freertos/FreeRTOS.h", "freertos/task.h",
                 "mbedtls/ecdsa.h", "mbedtls/pk.h", "mbedtls/sha256.h"]:
        header = temp / name
        header.parent.mkdir(parents=True, exist_ok=True)
        header.write_text('#include "online_host.h"\n')
    binary = temp / "online"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                    "-I" + str(temp), "-I" + str(HERE), "-I" + str(HERE.parent / "include"),
                    "-I" + str(COMPONENTS / "cp_settings/include"),
                    "-I" + str(COMPONENTS / "cp_settings/tests/host"),
                    "-I" + str(COMPONENTS / "cp_v3_evidence/include"),
                    str(HERE / "test_online.c"), str(HERE.parent / "online.c"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
