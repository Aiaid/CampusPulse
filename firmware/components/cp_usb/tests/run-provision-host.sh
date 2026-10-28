#!/usr/bin/env bash
set -euo pipefail
CP_USB="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_PROVISION="$CP_USB/../cp_provision"
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3}"
CP_OUT="$(mktemp -d "${TMPDIR:-/tmp}/cp-usb-provision-tests.XXXXXX")"
trap 'rm -rf "$CP_OUT"' EXIT
# Build the pinned SDK crypto fixture and run its existing provisioning tests.
bash "$CP_PROVISION/tests/build-sdk-peer.sh" "$CP_OUT"
CP_SDK="$IDF_PATH/components/protocomm"
CP_FLAGS=(-std=c11 -D_DEFAULT_SOURCE -g -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror -Wno-unused-parameter -Wno-unused-variable -Wno-sign-compare -include "$CP_PROVISION/tests/host/sdkconfig.h")
CP_INCLUDES=(-I"$CP_USB/include" -I"$CP_PROVISION" -I"$CP_PROVISION/tests/host" -I"$CP_SDK/include/common" -I"$CP_SDK/include/security" -I"$CP_SDK/include/transports" -I"$CP_SDK/include/crypto/srp6a" -I"$CP_SDK/src/crypto/srp6a" -I"$CP_SDK/proto-c" -I"$IDF_PATH/components/protobuf-c/protobuf-c" -I"$IDF_PATH/components/mbedtls/mbedtls/include" -I"$IDF_PATH/components/json/cJSON" -I"$CP_PROVISION/include" -I"$CP_PROVISION/../cp_settings/include" -I"$CP_PROVISION/../cp_network/include")
"${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -pthread \
 "$CP_USB/tests/test_provision.c" "$CP_USB/framing.c" "$CP_USB/controller.c" \
 "$CP_PROVISION/cp_provision_guard.c" "$CP_PROVISION/cp_provision_security2.c" \
 "$CP_PROVISION/../cp_settings/settings_validate.c" "$CP_PROVISION/../cp_network/diagnostic.c" \
 "$CP_OUT/sdk-patch/security2_checked.c" "$CP_SDK/src/crypto/srp6a/esp_srp.c" "$CP_SDK/src/crypto/srp6a/esp_srp_mpi.c" \
 "$CP_SDK/proto-c/session.pb-c.c" "$CP_SDK/proto-c/sec0.pb-c.c" "$CP_SDK/proto-c/sec1.pb-c.c" "$CP_SDK/proto-c/sec2.pb-c.c" "$CP_SDK/proto-c/constants.pb-c.c" \
 "$IDF_PATH/components/protobuf-c/protobuf-c/protobuf-c/protobuf-c.c" "$CP_OUT/cJSON.o" \
 "$CP_OUT/mbedtls/library/libmbedcrypto.a" -o "$CP_OUT/test-usb-provision"
"$CP_OUT/test-usb-provision"
