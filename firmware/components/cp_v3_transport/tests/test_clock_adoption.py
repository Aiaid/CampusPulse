"""Compile actual clock functions, excluding unrelated SDK network entrypoints.

No alternate clock implementation: function bodies are extracted verbatim from
transport.c/protocol.c. The full SDK compilation remains a separate build gate.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent


def function(source, name):
    match = re.search(r"^(?:static )?(?:esp_err_t|uint64_t|bool|void) " + re.escape(name) + r"\(", source, re.M)
    assert match, name
    opening = source.index("{", match.start())
    depth = 1
    position = opening + 1
    while depth:
        if source[position] == "{":
            depth += 1
        elif source[position] == "}":
            depth -= 1
        position += 1
    return source[match.start():position] + "\n"


source = (COMPONENT / "transport.c").read_text()
protocol = (COMPONENT / "protocol.c").read_text()
prefix = r'''
#include "cp_v3_transport.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#define ESP_ERR_NOT_SUPPORTED 0x106
typedef void *TaskHandle_t;
static TaskHandle_t s_owner,task;
static bool s_cancelled,s_wifi_initialized,s_wifi_started,s_date_known;
static cp_v3_transport_config_t s_config;
static cp_v3_time_t s_anchor,s_date;
static uint64_t s_observed_mono,s_observed_lower,now;
static bool wall_failure,cancel_on_wall,app_stopped;
static unsigned wall_calls;
static struct timeval wall;
static TaskHandle_t xTaskGetCurrentTaskHandle(void) { return task; }
static int64_t esp_timer_get_time(void) {
    /* Real SDK returns signed microseconds; cap host's impossible huge input
     * without signed-overflow UB while still exercising expired-anchor bounds. */
    return now>INT64_MAX/1000u ? INT64_MAX : (int64_t)(now*1000u);
}
static int clock_settimeofday(const struct timeval *tv,const void *zone) {
    (void)zone; ++wall_calls;
    if(wall_failure) return -1;
    wall=*tv;
    if(cancel_on_wall) s_cancelled=true;
    return 0;
}
#define settimeofday clock_settimeofday
'''
pieces = [prefix, function(protocol, "cp_v3_transport_anchor")]
for name in ["now_ms", "owner", "active", "set_wall_current", "set_wall_clock",
             "cp_v3_transport_time", "cp_v3_transport_adopt_clock",
             "cp_v3_transport_sync_clock", "cp_v3_transport_cancel"]:
    pieces.append(function(source, name))
pieces.append((HERE / "clock_adoption_test.c").read_text())
with tempfile.TemporaryDirectory(prefix="cp-clock-adoption-") as directory:
    temp = Path(directory)
    c_file = temp / "clock.c"
    c_file.write_text("\n".join(pieces))
    binary = temp / "clock"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                    "-I" + str(COMPONENT / "include"),
                    "-I" + str(COMPONENT.parent / "cp_settings/include"),
                    "-I" + str(COMPONENT.parent / "cp_settings/tests/host"),
                    "-I" + str(COMPONENT.parent / "cp_v3_evidence/include"),
                    str(c_file), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
