#!/usr/bin/env bash
set -euo pipefail
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-uv-cache}"
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF v5.5.3}"
CP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_OUT="${1:?Provide a temporary build directory}"
CP_SDK="$IDF_PATH/components/protocomm"
node --input-type=module - "$IDF_PATH" "$CP_DIR/../../../tests/provisioning/idf-security2-fixture.json" <<'JS_CHECK'
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve} from 'node:path';
const [idf,fixture]=process.argv.slice(2),expected=JSON.parse(readFileSync(fixture,'utf8')).source_sha256;
for(const [file,sha] of Object.entries(expected)){const actual=createHash('sha256').update(readFileSync(resolve(idf,file))).digest('hex');if(actual!==sha)throw Error('Pinned ESP-IDF source mismatch: '+file);}
console.log('Pinned ESP-IDF 5.5.3 protocol/reference/implementation source fingerprints: PASS');
JS_CHECK
mkdir -p "$CP_OUT"
uv run --no-project "$CP_DIR/cmake/patch_security2.py" --idf-path "$IDF_PATH" --output "$CP_OUT/sdk-patch"
cmake -S "$IDF_PATH/components/mbedtls/mbedtls" -B "$CP_OUT/mbedtls" -G Ninja \
  -DENABLE_PROGRAMS=OFF -DENABLE_TESTING=OFF -DCMAKE_BUILD_TYPE=Debug >"$CP_OUT/cmake.log"
cmake --build "$CP_OUT/mbedtls" --target mbedcrypto -j 6 >"$CP_OUT/build.log"
CP_FLAGS=(-std=c11 -D_DEFAULT_SOURCE -g -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror -Wno-unused-parameter -Wno-unused-variable -Wno-sign-compare -include "$CP_DIR/tests/host/sdkconfig.h")
CP_INCLUDES=(-I"$CP_DIR" -I"$CP_DIR/tests/host" -I"$CP_SDK/include/common" -I"$CP_SDK/include/security" -I"$CP_SDK/include/crypto/srp6a" -I"$CP_SDK/src/crypto/srp6a" -I"$CP_SDK/proto-c" -I"$IDF_PATH/components/protobuf-c/protobuf-c" -I"$IDF_PATH/components/mbedtls/mbedtls/include")
"${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" \
 "$CP_DIR/tests/sdk-peer.c" "$CP_DIR/cp_provision_security2.c" \
 "$CP_OUT/sdk-patch/security2_checked.c" "$CP_SDK/src/crypto/srp6a/esp_srp.c" "$CP_SDK/src/crypto/srp6a/esp_srp_mpi.c" \
 "$CP_SDK/proto-c/session.pb-c.c" "$CP_SDK/proto-c/sec0.pb-c.c" "$CP_SDK/proto-c/sec1.pb-c.c" "$CP_SDK/proto-c/sec2.pb-c.c" "$CP_SDK/proto-c/constants.pb-c.c" \
 "$IDF_PATH/components/protobuf-c/protobuf-c/protobuf-c/protobuf-c.c" "$CP_OUT/mbedtls/library/libmbedcrypto.a" -o "$CP_OUT/sdk-peer"
printf '%s\n' "$CP_OUT/sdk-peer"
"${CC:-clang}" "${CP_FLAGS[@]}" -Wno-deprecated-declarations -I"$IDF_PATH/components/json/cJSON" -c "$IDF_PATH/components/json/cJSON/cJSON.c" -o "$CP_OUT/cJSON.o"
"${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -pthread \
 -I"$CP_DIR/include" -I"$CP_DIR/../cp_settings/include" -I"$CP_DIR/../cp_network/include" -I"$CP_SDK/include/transports" \
 -I"$IDF_PATH/components/json/cJSON" \
 "$CP_DIR/tests/test_module.c" "$CP_DIR/cp_provision_guard.c" "$CP_DIR/cp_provision_security2.c" \
 "$CP_DIR/../cp_settings/settings_validate.c" "$CP_DIR/../cp_network/diagnostic.c" \
 "$CP_OUT/sdk-patch/security2_checked.c" "$CP_SDK/src/crypto/srp6a/esp_srp.c" "$CP_SDK/src/crypto/srp6a/esp_srp_mpi.c" \
 "$CP_SDK/proto-c/session.pb-c.c" "$CP_SDK/proto-c/sec0.pb-c.c" "$CP_SDK/proto-c/sec1.pb-c.c" "$CP_SDK/proto-c/sec2.pb-c.c" "$CP_SDK/proto-c/constants.pb-c.c" \
 "$IDF_PATH/components/protobuf-c/protobuf-c/protobuf-c/protobuf-c.c" "$CP_OUT/cJSON.o" \
 "$CP_OUT/mbedtls/library/libmbedcrypto.a" -o "$CP_OUT/test-module"
"$CP_OUT/test-module"
