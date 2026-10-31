#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd -- "$TEST_DIR/.." && pwd)"
FIRMWARE="$(cd -- "$PROJECT/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-bootstrap-host.XXXXXX")"
trap 'rm -rf -- "$OUT"' EXIT
CC_BIN="${CC:-cc}"
OPENSSL_BIN="${OPENSSL:-openssl}"
: "${IDF_PATH:?Set ESP-IDF 5.5.3 path for the real transport origin parser}"
PROTOCOL="$FIRMWARE/components/cp_v3_transport"
PROTO_INCLUDES=(-I "$PROTOCOL/include" -I "$PROTOCOL" -I "$IDF_PATH/components/http_parser")
PROTO_SOURCES=("$PROTOCOL/protocol.c" "$IDF_PATH/components/http_parser/http_parser.c")
PROTO_SOURCES+=("$FIRMWARE/components/cp_settings/settings_validate.c")
# Override MBEDTLS_PREFIX on hosts without pkg-config or Homebrew. Tests use
# the real mbedTLS parser, never a permissive certificate-parser stub.
if [[ -z "${MBEDTLS_PREFIX:-}" ]]; then
  if pkg-config --exists mbedx509 mbedcrypto; then
    MBEDTLS_PREFIX="$(pkg-config --variable=prefix mbedx509)"
  elif command -v brew >/dev/null 2>&1; then
    # Resolve the installed prefix without invoking brew's API/cache update.
    BREW_BIN="$(command -v brew)"
    MBEDTLS_PREFIX="${BREW_BIN%/bin/brew}/opt/mbedtls@3"
  else
    echo 'Set MBEDTLS_PREFIX to an installed mbedTLS 3.x prefix.' >&2
    exit 1
  fi
fi
for kind in ca leaf; do
  is_ca=FALSE
  if [[ "$kind" == ca ]]; then is_ca=TRUE; fi
  "$OPENSSL_BIN" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$OUT/$kind.key" -out "$OUT/$kind.pem" -days 1 \
    -subj /CN=Bootstrap-Synthetic-Host-Test \
    -addext "basicConstraints=critical,CA:$is_ca" >/dev/null 2>&1
done
"$CC_BIN" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -D_DEFAULT_SOURCE -Wno-unused-parameter "${PROTO_INCLUDES[@]}" "${PROTO_SOURCES[@]}" \
    -DTRIAL_BOOTSTRAP_HOST_TEST -I "$PROJECT/main" -I "$TEST_DIR" \
  -I "$FIRMWARE/components/cp_settings/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" -I "$MBEDTLS_PREFIX/include" \
  "$PROJECT/main/trial_bootstrap.c" "$TEST_DIR/test_trial_bootstrap.c" \
  -L "$MBEDTLS_PREFIX/lib" -lmbedx509 -lmbedcrypto -lm -o "$OUT/bootstrap"
"$OUT/bootstrap" "$OUT/ca.pem" "$OUT/leaf.pem"
"$CC_BIN" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -D_DEFAULT_SOURCE -Wno-unused-parameter "${PROTO_INCLUDES[@]}" "${PROTO_SOURCES[@]}" \
    -Dread=bootstrap_test_read -Dputs=bootstrap_test_puts \
  -Dprintf=bootstrap_test_printf -Dfflush=bootstrap_test_fflush \
  -I "$TEST_DIR/bootstrap_mock" -I "$PROJECT/main" -I "$TEST_DIR" \
  -I "$FIRMWARE/components/cp_settings/include" \
  -I "$FIRMWARE/components/cp_v3_evidence/include" -I "$MBEDTLS_PREFIX/include" \
  "$PROJECT/main/trial_bootstrap.c" "$TEST_DIR/test_trial_bootstrap_uart.c" \
  -L "$MBEDTLS_PREFIX/lib" -lmbedx509 -lmbedcrypto -o "$OUT/bootstrap-uart"
"$OUT/bootstrap-uart"
