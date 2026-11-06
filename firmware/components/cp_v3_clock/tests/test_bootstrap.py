"""Execute actual bootstrap.c with deterministic SDK doubles and sanitizers."""
from pathlib import Path
import os
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
COMPONENTS = HERE.parents[1]
with tempfile.TemporaryDirectory(prefix="cp-clock-bootstrap-") as directory:
    temp = Path(directory)
    for name in [
        "sdkconfig.h", "esp_crt_bundle.h", "esp_event.h", "esp_eap_client.h",
        "esp_http_client.h", "esp_log.h", "esp_netif.h", "esp_random.h",
        "esp_sntp.h", "esp_timer.h", "esp_wifi.h", "freertos/FreeRTOS.h",
        "freertos/task.h", "mbedtls/ecdsa.h", "mbedtls/pk.h", "mbedtls/sha256.h",
    ]:
        header = temp / name
        header.parent.mkdir(parents=True, exist_ok=True)
        header.write_text('#include "bootstrap_host.h"\n')
    binary = temp / "bootstrap"
    subprocess.run([
        os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
        "-Dgettimeofday=clock_test_gettimeofday", "-Dsettimeofday=clock_test_settimeofday",
        "-I" + str(temp), "-I" + str(HERE),
        "-I" + str(HERE.parent / "include"),
        "-I" + str(COMPONENTS / "cp_settings/include"),
        "-I" + str(COMPONENTS / "cp_settings/tests/host"),
        "-I" + str(COMPONENTS / "cp_v3_evidence/include"),
        str(HERE / "test_bootstrap.c"), str(HERE.parent / "bootstrap.c"),
        str(COMPONENTS / "cp_settings/settings_validate.c"), "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
