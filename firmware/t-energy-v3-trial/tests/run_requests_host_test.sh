#!/usr/bin/env bash
set -euo pipefail
TE_TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TE_PROJECT="$(cd -- "$TE_TEST_DIR/.." && pwd)"
TE_FIRMWARE="$(cd -- "$TE_PROJECT/.." && pwd)"
: "${IDF_PATH:?Set ESP-IDF 5.5.3 path}"
TE_REQUEST_OUT="$(mktemp -d "${TMPDIR:-/tmp}/te-request-host.XXXXXX")"
trap 'rm -rf -- "$TE_REQUEST_OUT"' EXIT
read -r -a CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
INCLUDES=(-I "$TE_TEST_DIR/request_mock" -I "$TE_PROJECT/main" -I "$IDF_PATH/components/esp-tls"
    -I "$IDF_PATH/components/mbedtls/mbedtls/include" -I "$IDF_PATH/components/json/cJSON")
for component in cp_v3_transport cp_settings cp_v3_evidence cp_v3_budget;do INCLUDES+=(-I "$TE_FIRMWARE/components/$component/include");done
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -fsanitize=address,undefined \
    "${INCLUDES[@]}" "$TE_TEST_DIR/test_small_runtime_requests.c" \
    "$TE_FIRMWARE/components/cp_v3_budget/budget.c" "$IDF_PATH/components/json/cJSON/cJSON.c" \
    "${CRYPTO_FLAGS[@]}" -lm -o "$TE_REQUEST_OUT/test"
"$TE_REQUEST_OUT/test"
