"""Host-test adapter bindings with real USB framing/controller and fake platform I/O."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ROOT.parent / "components"


class AdapterTests(unittest.TestCase):
    def test_adapter_and_buttons(self):
        sdk = os.environ.get("IDF_PATH")
        if not sdk:
            self.skipTest("Set IDF_PATH to compile the existing SDK cJSON source")
        headers = {
            "freertos/FreeRTOS.h": "#pragma once\n#include <stdint.h>\ntypedef unsigned TickType_t;\ntypedef int portMUX_TYPE;\n#define portMUX_INITIALIZER_UNLOCKED 0\n#define portENTER_CRITICAL(p) ((void)(p))\n#define portEXIT_CRITICAL(p) ((void)(p))\n#define pdPASS 1\n#define pdMS_TO_TICKS(ms) (ms)\n",
            "freertos/task.h": "#pragma once\n#include \"FreeRTOS.h\"\ntypedef void *TaskHandle_t;\nint xTaskCreate(void(*)(void*),const char*,unsigned,void*,unsigned,TaskHandle_t*);\nvoid vTaskDelay(TickType_t);\n",
            "bootloader_random.h": "#pragma once\nvoid bootloader_random_enable(void);\nvoid bootloader_random_disable(void);\n",
            "esp_mac.h": "#pragma once\n#include <stdint.h>\n#include \"esp_err.h\"\nesp_err_t esp_efuse_mac_get_default(uint8_t*);\n",
            "esp_system.h": "#pragma once\nint esp_reset_reason(void);\n",
        }
        with tempfile.TemporaryDirectory(prefix="campuspulse-setup-adapter-") as directory:
            root = Path(directory)
            for name, content in headers.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            includes = [root, ROOT / "main", COMPONENTS / "cp_usb/include",
                        COMPONENTS / "cp_settings/include", COMPONENTS / "cp_provision/include",
                        COMPONENTS / "cp_network/include", COMPONENTS / "cp_core/include",
                        COMPONENTS / "cp_settings/tests/host", COMPONENTS / "cp_provision/tests/host",
                        COMPONENTS / "cp_usb/tests/host", Path(sdk) / "components/json/cJSON"]
            sources = [ROOT / "tests/setup_adapter_test.c", ROOT / "main/raw_setup.c",
                       ROOT / "main/raw_usb_stream.c", ROOT / "main/raw_control.c",
                       ROOT / "main/raw_boot_button.c", ROOT / "main/raw_setup_radio.c",
                       COMPONENTS / "cp_settings/settings_validate.c",
                       COMPONENTS / "cp_core/cp_core.c", COMPONENTS / "cp_usb/framing.c",
                       COMPONENTS / "cp_usb/controller.c"]
            command = [os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                       "-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
            for path in includes:
                command += ["-I", str(path)]
            binary = root / "adapter"
            cjson = root / "cJSON.o"
            subprocess.run(command + ["-Wno-deprecated-declarations", "-c",
                str(Path(sdk) / "components/json/cJSON/cJSON.c"), "-o", str(cjson)], check=True)
            subprocess.run(command + list(map(str, sources)) + [str(cjson), "-o", str(binary)], check=True)
            for case in ("normal", "short-write", "drain-failure", "expired", "back-to-back",
                         "callbacks-pending", "stop-failed", "power-race", "power-before-begin",
                         "power-before-validation", "power-before-save"):
                subprocess.run([str(binary), case], check=True)


if __name__ == "__main__":
    unittest.main()
