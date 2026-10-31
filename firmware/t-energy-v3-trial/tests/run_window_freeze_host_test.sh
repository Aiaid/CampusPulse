#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd -- "$TEST_DIR/.." && pwd)"
COMPONENTS="$(cd -- "$PROJECT/../components" && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-te-freeze.XXXXXX")"
trap 'rm -rf -- "$OUT"' EXIT
read -r -a CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I "$TEST_DIR" -I "$PROJECT/main" \
  -I "$COMPONENTS/cp_v3_capture/include" -I "$COMPONENTS/cp_v3_stats/include" \
  -I "$COMPONENTS/cp_v3_temporal/include" -I "$COMPONENTS/cp_v3_evidence/include" \
  -I "$COMPONENTS/cp_v3_small_results/include" \
  "$PROJECT/main/board_admission.c" "$PROJECT/main/board_report.c" \
  "$PROJECT/main/board_stats_worker.c" "$PROJECT/main/board_stats_window.c" \
  "$PROJECT/main/board_window_freeze.c" "$COMPONENTS/cp_v3_stats/stats.c" \
  "$COMPONENTS/cp_v3_small_results/wire.c" "$TEST_DIR/test_board_window_freeze.c" \
  "${CRYPTO_FLAGS[@]}" -o "$OUT/window-freeze"
"$OUT/window-freeze"
