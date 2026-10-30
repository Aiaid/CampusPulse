#!/usr/bin/env bash
set -euo pipefail
CP_NETWORK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_COMPONENTS_DIR="$(cd -- "$CP_NETWORK_DIR/.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to the installed ESP-IDF 5.5.3 tree}"
CP_JSON_DIR="$IDF_PATH/components/json/cJSON"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-network-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR" "$CP_NETWORK_DIR/tests/test_control_schedule.c" \
    -o "$CP_TEST_DIR/test-control-schedule"
"$CP_TEST_DIR/test-control-schedule"
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR" "$CP_NETWORK_DIR/tests/test_http_cache.c" \
    -o "$CP_TEST_DIR/test-http-cache"
"$CP_TEST_DIR/test-http-cache"
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR" "$CP_NETWORK_DIR/tests/test_http_cache_drop.c" \
    -o "$CP_TEST_DIR/test-http-cache-drop"
"$CP_TEST_DIR/test-http-cache-drop"
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR" "$CP_NETWORK_DIR/tests/test_http_path_probe.c" \
    -o "$CP_TEST_DIR/test-http-path-probe"
"$CP_TEST_DIR/test-http-path-probe"
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined -pthread \
    -I"$CP_NETWORK_DIR/tests/alloc_host" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    "$CP_NETWORK_DIR/tests/test_alloc_monitor.c" -o "$CP_TEST_DIR/test-alloc-monitor"
"$CP_TEST_DIR/test-alloc-monitor"
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR/include" -I"$CP_COMPONENTS_DIR/cp_pipeline/include" \
    -I"$CP_COMPONENTS_DIR/cp_core/include" -I"$CP_COMPONENTS_DIR/cp_settings/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    "$CP_NETWORK_DIR/tests/test_frozen_json.c" -o "$CP_TEST_DIR/test-frozen-json"
"$CP_TEST_DIR/test-frozen-json"
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR" "$CP_NETWORK_DIR/tests/test_mqtt_rpc.c" -o "$CP_TEST_DIR/test-mqtt-rpc"
"$CP_TEST_DIR/test-mqtt-rpc"
for CP_NATIVE_TLS in 0 1; do
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -pthread \
    -DCONFIG_CP_NETWORK_MQTT_NATIVE_TLS="$CP_NATIVE_TLS" \
    -I"$CP_NETWORK_DIR/tests/mqtt_host" -I"$CP_NETWORK_DIR/tests/host" \
    -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    "$CP_NETWORK_DIR/tests/test_mqtt_wss.c" "$CP_COMPONENTS_DIR/cp_settings/settings_validate.c" -o "$CP_TEST_DIR/test-mqtt-$CP_NATIVE_TLS"
"$CP_TEST_DIR/test-mqtt-$CP_NATIVE_TLS"
done
# Disabled transport must not retain references to MQTT, TLS, or OS SDK APIs.
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -DCONFIG_CP_NETWORK_MQTT_WSS=0 \
    -I"$CP_NETWORK_DIR/tests/mqtt_host" -I"$CP_NETWORK_DIR/tests/host" \
    -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    "$CP_NETWORK_DIR/tests/test_mqtt_disabled.c" -o "$CP_TEST_DIR/test-mqtt-disabled"
"$CP_TEST_DIR/test-mqtt-disabled"
read -r -a CP_CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
# Keep platform deprecation suppression limited to the pinned upstream cJSON.
clang -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -g -fsanitize=address,undefined \
    -I"$CP_JSON_DIR" -c "$CP_JSON_DIR/cJSON.c" -o "$CP_TEST_DIR/cJSON.o"
for CP_ADDRESS_CAPACITY in 128 512; do
CP_BATCH_ITEMS=16
if [[ "$CP_ADDRESS_CAPACITY" == 512 ]]; then CP_BATCH_ITEMS=64; fi
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -DCP_NETWORK_HOST_TEST -DCONFIG_CP_COLLECT_MAX_ADDRESSES="$CP_ADDRESS_CAPACITY" -DCONFIG_CP_NETWORK_MAX_BATCH_ITEMS="$CP_BATCH_ITEMS" \
    -I"$CP_NETWORK_DIR/tests/host" -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    -I"$CP_JSON_DIR" "$CP_NETWORK_DIR/protocol.c" "$CP_TEST_DIR/cJSON.o" \
    "$CP_NETWORK_DIR/tests/test_protocol.c" "${CP_CRYPTO_FLAGS[@]}" -o "$CP_TEST_DIR/test-protocol"
"$CP_TEST_DIR/test-protocol"
done
for CP_BATCH_ITEMS in 16 64; do
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -DCP_NETWORK_HOST_TEST -DCONFIG_CP_NETWORK_MAX_BATCH_ITEMS="$CP_BATCH_ITEMS" \
    -I"$CP_NETWORK_DIR/tests/host" -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" \
    -I"$CP_COMPONENTS_DIR/cp_core/include" -I"$CP_COMPONENTS_DIR/cp_settings/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" -I"$CP_JSON_DIR" \
    "$CP_NETWORK_DIR/protocol.c" "$CP_TEST_DIR/cJSON.o" "$CP_NETWORK_DIR/tests/test_ack_canonical.c" \
    "${CP_CRYPTO_FLAGS[@]}" -o "$CP_TEST_DIR/test-ack-canonical"
"$CP_TEST_DIR/test-ack-canonical"
done
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR/tests/host" -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    -I"$CP_JSON_DIR" "$CP_NETWORK_DIR/tests/test_control.c" "$CP_TEST_DIR/cJSON.o" \
    -o "$CP_TEST_DIR/test-control"
"$CP_TEST_DIR/test-control"
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    "$CP_NETWORK_DIR/tests/test_clock.c" -o "$CP_TEST_DIR/test-clock"
"$CP_TEST_DIR/test-clock"
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    "$CP_NETWORK_DIR/diagnostic.c" "$CP_NETWORK_DIR/diagnostic_store.c" \
    "$CP_NETWORK_DIR/tests/test_diagnostic.c" -o "$CP_TEST_DIR/test-diagnostic"
"$CP_TEST_DIR/test-diagnostic"

clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    "$CP_NETWORK_DIR/tests/test_upload_metrics.c" -o "$CP_TEST_DIR/test-upload-metrics"
"$CP_TEST_DIR/test-upload-metrics"

uv run --no-project "$CP_NETWORK_DIR/tests/test_transport_async.py" --idf-path "$IDF_PATH"
