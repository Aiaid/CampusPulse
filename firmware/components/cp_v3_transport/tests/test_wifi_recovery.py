"""Exercise actual transport recovery/preflight with mocked SDK operations.

Production function bodies and the existing bounded startup loop are compiled
verbatim; SDK/hardware behavior is a separate firmware/physical acceptance gate.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent


def function(source, name):
    match = re.search(r"^(?:static )?(?:esp_err_t|uint64_t|bool|void|int|v3_wifi_snapshot_t) "
                      + re.escape(name) + r"\(", source, re.M)
    assert match, name
    opening = source.index("{", match.start())
    depth, position = 1, opening + 1
    while depth:
        if source[position] == "{":
            depth += 1
        elif source[position] == "}":
            depth -= 1
        position += 1
    return source[match.start():position] + "\n"


prefix = r'''
#include "cp_v3_transport.h"
#include "wifi_startup.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#define ESP_ERR_WIFI_NOT_STARTED 0x3002
#define pdMS_TO_TICKS(ms) (ms)
typedef void *TaskHandle_t;
static TaskHandle_t s_owner,task;
static bool s_cancelled,s_wifi_initialized,s_wifi_started,s_link,app_stopped;
static uint32_t s_wifi_events,s_wifi_disconnect_seq,s_wifi_disconnect_reason;
static cp_v3_transport_config_t s_config;
static uint64_t now,ready_at,cancel_at;
static unsigned stop_calls,disconnect_calls,connect_calls,radio_stop_calls,clock_calls;
static unsigned cancel_operation;
static bool fail_every_connect;
static esp_err_t stop_result,disconnect_result,connect_result,clock_result;
static TaskHandle_t xTaskGetCurrentTaskHandle(void){return task;}
static int64_t esp_timer_get_time(void){return (int64_t)now*1000;}
static bool app_cancel(void){return app_stopped;}
static esp_err_t cp_v3_mqtt_stop(void){
    ++stop_calls;if(cancel_operation==1)s_cancelled=true;return stop_result;
}
static esp_err_t esp_wifi_stop(void){++radio_stop_calls;return ESP_OK;}
static esp_err_t esp_wifi_disconnect(void){
    ++disconnect_calls;if(cancel_operation==2)s_cancelled=true;return disconnect_result;
}
static esp_err_t esp_wifi_connect(void){
    ++connect_calls;
    if(cancel_operation==3)s_cancelled=true;
    if(fail_every_connect){++s_wifi_disconnect_seq;s_wifi_disconnect_reason=200;}
    return connect_result;
}
static void vTaskDelay(uint32_t delay){
    now+=delay;
    if(ready_at&&now>=ready_at)s_link=true;
    if(cancel_at&&now>=cancel_at)app_stopped=true;
}
static void wifi_notice(void *ctx,uint32_t event,uint32_t reason,unsigned attempt,uint64_t elapsed,bool ip){
    (void)ctx;(void)event;(void)reason;(void)attempt;(void)elapsed;(void)ip;
}
esp_err_t cp_v3_transport_time(cp_v3_time_t *out){
    ++clock_calls;memset(out,0,sizeof *out);return clock_result;
}
'''
source = (COMPONENT / "transport.c").read_text()
pieces = [prefix]
for name in ["now_ms", "owner", "active", "wifi_now", "wifi_active", "wifi_snapshot",
             "wifi_connect", "wifi_pause", "cp_v3_transport_cancel", "cp_v3_transport_wifi_state",
             "cp_v3_transport_reconnect_wifi", "request_preflight"]:
    pieces.append(function(source, name))
pieces.append((HERE / "wifi_recovery_test.c").read_text())
with tempfile.TemporaryDirectory(prefix="cp-wifi-recovery-") as directory:
    temp = Path(directory)
    c_file, binary = temp / "recovery.c", temp / "recovery"
    c_file.write_text("\n".join(pieces))
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                    "-I" + str(COMPONENT), "-I" + str(COMPONENT / "include"),
                    "-I" + str(COMPONENT.parent / "cp_settings/include"),
                    "-I" + str(COMPONENT.parent / "cp_settings/tests/host"),
                    "-I" + str(COMPONENT.parent / "cp_v3_evidence/include"),
                    str(c_file), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
