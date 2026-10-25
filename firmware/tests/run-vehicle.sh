#!/bin/sh
set -eu
CP_TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CP_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-vehicle.XXXXXX")
trap 'rm -rf "$CP_TEMP_DIR"' EXIT HUP INT TERM
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
  -fno-omit-frame-pointer -I"$CP_TEST_DIR/../components/cp_vehicle/include" \
  "$CP_TEST_DIR/../components/cp_vehicle/cp_vehicle.c" "$CP_TEST_DIR/test_vehicle.c" \
  -o "$CP_TEMP_DIR/test_vehicle"
"$CP_TEMP_DIR/test_vehicle"
