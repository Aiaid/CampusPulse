#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd -- "$TEST_DIR/.." && pwd)"
FIRMWARE="$(cd -- "$PROJECT/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-te-host.XXXXXX")"
trap 'rm -rf -- "$OUT"' EXIT
CC_BIN="${CC:-cc}"
FLAGS=(-std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined)
bash "$TEST_DIR/run_maintenance_host_test.sh"
bash "$TEST_DIR/run_requests_host_test.sh"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-v3-uv}" uv run --no-project "$FIRMWARE/components/cp_v3_transport/tests/test_mqtt_protocol.py"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-v3-uv}" uv run --no-project "$FIRMWARE/components/cp_v3_transport/tests/test_build_isolation.py"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$TEST_DIR" \
  -I "$FIRMWARE/components/cp_v3_control/include" -I "$FIRMWARE/components/cp_v3_evidence/include" \
  -I "$FIRMWARE/components/cp_v3_queue/include" \
  -I "$FIRMWARE/components/cp_settings/include" \
  -I "$FIRMWARE/components/cp_v3_temporal/include" "$TEST_DIR/test_small_runtime_logic.c" -o "$OUT/small-logic"
"$OUT/small-logic"
bash "$TEST_DIR/run_bootstrap_host_test.sh"
bash "$TEST_DIR/run_control_runtime_real.sh"
bash "$TEST_DIR/run_coordinator_host_test.sh"
bash "$PROJECT/identity/tests/run.sh"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-v3-uv}" uv run --no-project "$PROJECT/history/tests/run.py"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-v3-uv}" uv run --no-project "$PROJECT/history/tests/run_local_guard.py"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" "$PROJECT/main/board_runtime.c" \
  "$TEST_DIR/test_board_runtime.c" -o "$OUT/runtime"
"$OUT/runtime"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR" -I "$PROJECT/main" -I "$PROJECT/flash_queue/nvs_store" \
  -I "$FIRMWARE/components/cp_v3_capture/include" -I "$FIRMWARE/components/cp_v3_control/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" -I "$FIRMWARE/components/cp_v3_queue/include" \
  -I "$FIRMWARE/components/cp_v3_budget/include" \
  -I "$FIRMWARE/components/cp_v3_transport/include" \
  -I "$FIRMWARE/components/cp_settings/include" \
  -I "$FIRMWARE/components/cp_v3_stats/include" -I "$FIRMWARE/components/cp_v3_temporal/include" \
  -I "$FIRMWARE/components/cp_v3_small_results/include" "$PROJECT/main/board_runtime_adapters.c" \
  "$PROJECT/main/board_handoff.c" "$TEST_DIR/test_board_runtime_adapters.c" -o "$OUT/runtime-adapters"
"$OUT/runtime-adapters"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR" -I "$PROJECT/main" \
  -I "$FIRMWARE/components/cp_v3_capture/include" -I "$FIRMWARE/components/cp_v3_control/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" -I "$FIRMWARE/components/cp_v3_stats/include" \
  -I "$FIRMWARE/components/cp_v3_temporal/include" "$PROJECT/main/board_shared_capture.c" \
  "$TEST_DIR/test_board_shared_capture.c" "$FIRMWARE/components/cp_v3_temporal/temporal.c" -o "$OUT/shared-capture"
"$OUT/shared-capture"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" \
  "$PROJECT/main/board_admission.c" "$TEST_DIR/test_board_admission.c" -o "$OUT/admission"
"$OUT/admission"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$FIRMWARE/components/cp_v3_stats/include" \
  "$PROJECT/main/board_report.c" "$TEST_DIR/test_board_report.c" -o "$OUT/report"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$FIRMWARE/components/cp_v3_stats/include" \
  -I "$FIRMWARE/components/cp_v3_temporal/include" "$PROJECT/main/board_admission.c" \
  "$PROJECT/main/board_resources.c" "$TEST_DIR/test_board_resources.c" -o "$OUT/resources"
"$OUT/resources"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$FIRMWARE/components/cp_v3_stats/include" \
  -I "$FIRMWARE/components/cp_v3_temporal/include" "$PROJECT/main/board_admission.c" \
  "$PROJECT/main/board_resources.c" "$FIRMWARE/components/cp_v3_stats/stats.c" \
  "$FIRMWARE/components/cp_v3_temporal/temporal.c" "$TEST_DIR/test_board_resources_real.c" -o "$OUT/resources-real"
"$OUT/resources-real"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR/esp_mock" -I "$PROJECT/main" \
  -I "$FIRMWARE/components/cp_v3_stats/include" -I "$FIRMWARE/components/cp_v3_temporal/include" \
  "$PROJECT/main/board_resources_esp.c" "$TEST_DIR/test_board_resources_esp.c" -o "$OUT/esp-resources"
"$OUT/esp-resources"
"$OUT/report"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$FIRMWARE/components/cp_v3_stats/include" \
  "$PROJECT/main/board_report.c" "$PROJECT/main/board_stats_worker.c" \
  "$FIRMWARE/components/cp_v3_stats/stats.c" "$TEST_DIR/test_board_stats_worker.c" -o "$OUT/stats-worker"
"$OUT/stats-worker"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$FIRMWARE/components/cp_v3_stats/include" \
  "$PROJECT/main/board_report.c" "$PROJECT/main/board_stats_worker.c" "$PROJECT/main/board_stats_window.c" \
  "$FIRMWARE/components/cp_v3_stats/stats.c" "$TEST_DIR/test_board_stats_window.c" -o "$OUT/stats-window"
"$OUT/stats-window"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" "$PROJECT/main/board_capture.c" \
  "$TEST_DIR/test_board_capture.c" -o "$OUT/capture"
"$OUT/capture"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" "$PROJECT/main/board_handoff.c" \
  "$TEST_DIR/test_board_handoff.c" -o "$OUT/handoff"
"$OUT/handoff"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR" -I "$PROJECT/main" \
  -I "$FIRMWARE/components/cp_v3_capture/include" -I "$FIRMWARE/components/cp_v3_stats/include" \
  -I "$FIRMWARE/components/cp_v3_temporal/include" -I "$FIRMWARE/components/cp_v3_evidence/include" \
  -c "$PROJECT/main/board_handoff_capture_check.c" -o "$OUT/handoff-check.o"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR" -I "$PROJECT/main" \
  -I "$FIRMWARE/components/cp_settings/include" \
  "$PROJECT/main/board_settings.c" "$TEST_DIR/test_board_settings.c" -o "$OUT/settings"
"$OUT/settings"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/flash_queue/write_budget" \
  "$PROJECT/flash_queue/write_budget/write_budget.c" \
  "$PROJECT/flash_queue/write_budget/tests/test.c" -o "$OUT/budget"
"$OUT/budget"
bash "$TEST_DIR/run_window_freeze_host_test.sh"
"$CC_BIN" "${FLAGS[@]}" -I "$FIRMWARE/components/cp_v3_queue/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" \
  -I "$PROJECT/flash_queue/nvs_store/tests" -I "$PROJECT/flash_queue/nvs_store" \
  "$PROJECT/flash_queue/nvs_store/nvs_store.c" "$PROJECT/flash_queue/nvs_store/tests/test.c" \
  "$FIRMWARE/components/cp_v3_queue/queue.c" \
  "$FIRMWARE/components/cp_v3_evidence/wire.c" "$FIRMWARE/components/cp_v3_evidence/evidence.c" -o "$OUT/nvs-store"
"$OUT/nvs-store"
# Synthetic backend control fixtures; real matcher and OpenSSL SHA-256.
read -r -a CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR" -I "$PROJECT/main" -I "$PROJECT/flash_queue/nvs_store/tests" \
  -I "$FIRMWARE/components/cp_v3_budget/include" -I "$FIRMWARE/components/cp_v3_control/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" "$TEST_DIR/test_board_budget.c" \
  "${CRYPTO_FLAGS[@]}" -o "$OUT/board-budget"
"$OUT/board-budget"
"$CC_BIN" "${FLAGS[@]}" -I "$TEST_DIR" -I "$PROJECT/main" \
  -I "$FIRMWARE/components/cp_v3_stats/include" -I "$FIRMWARE/components/cp_v3_temporal/include" \
  -I "$FIRMWARE/components/cp_v3_control/include" -I "$FIRMWARE/components/cp_v3_control" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" "$PROJECT/main/board_capabilities.c" \
  "$TEST_DIR/test_board_capabilities.c" "$FIRMWARE/components/cp_v3_stats/stats.c" \
  "$FIRMWARE/components/cp_v3_temporal/temporal.c" "$FIRMWARE/components/cp_v3_control/control.c" \
  "$FIRMWARE/components/cp_v3_control/small.c" "$FIRMWARE/components/cp_v3_control/json.c" \
  "$FIRMWARE/components/cp_v3_evidence/wire.c" "$FIRMWARE/components/cp_v3_evidence/evidence.c" \
  "${CRYPTO_FLAGS[@]}" -o "$OUT/capabilities"
"$OUT/capabilities"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$TEST_DIR" \
  -I "$FIRMWARE/components/cp_v3_queue/include" -I "$FIRMWARE/components/cp_v3_evidence/include" \
  -I "$FIRMWARE/components/cp_v3_capture/include" -I "$FIRMWARE/components/cp_v3_stats/include" \
  -I "$FIRMWARE/components/cp_v3_temporal/include" -I "$FIRMWARE/components/cp_v3_small_results/include" \
  -I "$PROJECT/flash_queue/nvs_store/tests" -I "$PROJECT/flash_queue/nvs_store" \
  "$PROJECT/flash_queue/nvs_store/nvs_store.c" "$PROJECT/flash_queue/nvs_store/tests/window_handoff.c" \
  "$PROJECT/main/board_window_freeze.c" "$PROJECT/main/board_handoff.c" \
  "$PROJECT/main/board_report.c" "$PROJECT/main/board_stats_worker.c" "$PROJECT/main/board_stats_window.c" \
  "$FIRMWARE/components/cp_v3_stats/stats.c" "$FIRMWARE/components/cp_v3_small_results/wire.c" \
  "$FIRMWARE/components/cp_v3_queue/queue.c" "$FIRMWARE/components/cp_v3_evidence/wire.c" \
  "$FIRMWARE/components/cp_v3_evidence/evidence.c" "${CRYPTO_FLAGS[@]}" -o "$OUT/window-handoff"
"$OUT/window-handoff"
"$CC_BIN" "${FLAGS[@]}" -I "$FIRMWARE/components/cp_v3_queue/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" -I "$FIRMWARE/components/cp_v3_control" \
  -I "$FIRMWARE/components/cp_v3_control/include" -I "$PROJECT/flash_queue/nvs_store/tests" \
  -I "$PROJECT/flash_queue/nvs_store" "$PROJECT/flash_queue/nvs_store/nvs_store.c" \
  "$PROJECT/flash_queue/nvs_store/tests/control_receipt.c" "$FIRMWARE/components/cp_v3_queue/queue.c" \
  "$FIRMWARE/components/cp_v3_evidence/wire.c" "$FIRMWARE/components/cp_v3_evidence/evidence.c" \
  "$FIRMWARE/components/cp_v3_control/control.c" "$FIRMWARE/components/cp_v3_control/small.c" \
  "$FIRMWARE/components/cp_v3_control/json.c" "${CRYPTO_FLAGS[@]}" -o "$OUT/control-receipt"
"$CC_BIN" "${FLAGS[@]}" -I "$PROJECT/main" -I "$FIRMWARE/components/cp_v3_queue/include" \
  -I "$FIRMWARE/components/cp_v3_budget/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" -I "$FIRMWARE/components/cp_v3_control" \
  -I "$FIRMWARE/components/cp_v3_control/include" -I "$PROJECT/flash_queue/nvs_store/tests" \
  -I "$PROJECT/flash_queue/nvs_store" "$PROJECT/main/board_small_queue.c" \
  "$TEST_DIR/test_board_small_queue.c" "$PROJECT/flash_queue/nvs_store/nvs_store.c" \
  "$FIRMWARE/components/cp_v3_queue/queue.c" "$FIRMWARE/components/cp_v3_evidence/wire.c" \
  "$FIRMWARE/components/cp_v3_evidence/evidence.c" "$FIRMWARE/components/cp_v3_budget/budget.c" "$FIRMWARE/components/cp_v3_control/control.c" \
  "$FIRMWARE/components/cp_v3_control/small.c" "$FIRMWARE/components/cp_v3_control/json.c" \
  "${CRYPTO_FLAGS[@]}" -o "$OUT/board-small-queue"
TEMPLATES="$PROJECT/flash_queue/nvs_store/tests/fixtures"
node "$FIRMWARE/../scripts/generate-v3-statistics-control-fixtures.mjs" | \
  node "$PROJECT/flash_queue/nvs_store/tests/fixture_parity.mjs" "$OUT"
for fixture_dir in "$TEMPLATES" "$OUT"; do
  for name in applied-ack failed-ack lease; do
    stream=config_ack
    if [[ "$name" == lease ]]; then stream=lease; fi
    "$OUT/control-receipt" "$fixture_dir/$name-request.json" "$fixture_dir/$name-receipt.json" "$stream"
    "$OUT/board-small-queue" "$fixture_dir/$name-request.json" "$fixture_dir/$name-receipt.json"
  done
done
