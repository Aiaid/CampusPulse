#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd -- "$TEST_DIR/.." && pwd)"
FIRMWARE="$(cd -- "$PROJECT/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-te-coordinator.XXXXXX")"
trap 'rm -rf -- "$OUT"' EXIT
if [[ -z "${MBEDTLS_PREFIX:-}" ]]; then
  if pkg-config --exists mbedx509 mbedcrypto; then
    MBEDTLS_PREFIX="$(pkg-config --variable=prefix mbedx509)"
  elif command -v brew >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
    MBEDTLS_PREFIX="${BREW_BIN%/bin/brew}/opt/mbedtls@3"
  else
    echo 'Set MBEDTLS_PREFIX to an installed mbedTLS 3.x prefix.' >&2
    exit 1
  fi
fi
"${OPENSSL:-openssl}" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$OUT/ca.key" -out "$OUT/ca.pem" -days 1 -subj /CN=Coordinator-Synthetic-Host-Test \
  -addext 'basicConstraints=critical,CA:TRUE' >/dev/null 2>&1
INCLUDES=(-I "$TEST_DIR" -I "$PROJECT/main" -I "$PROJECT/flash_queue/nvs_store" -I "$MBEDTLS_PREFIX/include")
: "${IDF_PATH:?Set ESP-IDF 5.5.3 path for the real transport origin parser}"
INCLUDES+=(-I "$FIRMWARE/components/cp_v3_transport" -I "$IDF_PATH/components/http_parser")
for component in cp_v3_capture cp_v3_control cp_v3_evidence cp_v3_queue cp_v3_budget cp_v3_transport cp_settings cp_v3_stats cp_v3_temporal cp_v3_small_results; do
  INCLUDES+=(-I "$FIRMWARE/components/$component/include")
done
"${CC:-cc}" -std=c11 -D_DEFAULT_SOURCE -Wno-unused-parameter -Wall -Wextra -Werror -fsanitize=address,undefined -DTRIAL_BOOTSTRAP_HOST_TEST \
  "${INCLUDES[@]}" "$PROJECT/main/board_coordinator.c" "$PROJECT/main/board_runtime.c" \
  "$PROJECT/main/board_shared_capture.c" "$PROJECT/main/board_capabilities.c" \
  "$PROJECT/main/trial_bootstrap.c" "$TEST_DIR/test_board_coordinator.c" \
  "$FIRMWARE/components/cp_v3_stats/stats.c" "$FIRMWARE/components/cp_v3_temporal/temporal.c" \
  "$FIRMWARE/components/cp_v3_transport/protocol.c" "$IDF_PATH/components/http_parser/http_parser.c" \
  -L "$MBEDTLS_PREFIX/lib" -lmbedx509 -lmbedcrypto -o "$OUT/coordinator"
"$OUT/coordinator" "$OUT/ca.pem"
