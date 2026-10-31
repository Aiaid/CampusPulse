#!/usr/bin/env bash
# Synthetic offline collector capacity; no wire codec or device/cloud I/O.
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-capacity-tests.XXXXXX")"
trap 'rm -rf -- "$CP_BUILD"' EXIT
CP_FLAGS=(-std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined -fno-omit-frame-pointer)
CP_INCLUDES=(-I"$CP_FW/components/cp_collect/include" -I"$CP_FW/components/cp_vehicle/include")
CP_SOURCES=("$CP_FW/components/cp_collect/cp_collect.c" "$CP_FW/components/cp_vehicle/cp_vehicle.c")
for CP_CAPACITY in 128 512; do
    "${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -DCONFIG_CP_COLLECT_MAX_ADDRESSES="$CP_CAPACITY" \
        "$CP_FW/tests/test_collect_capacity.c" "${CP_SOURCES[@]}" -o "$CP_BUILD/test-$CP_CAPACITY"
    "$CP_BUILD/test-$CP_CAPACITY"
done
