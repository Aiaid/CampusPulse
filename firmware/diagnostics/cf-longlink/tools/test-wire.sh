#!/bin/sh
set -eu
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3}"
probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
probe_tmp=$(mktemp -d "${TMPDIR:-/tmp}/cp-link-wire.XXXXXX")
trap 'rm -rf "$probe_tmp"' EXIT HUP INT TERM
clang -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -fsanitize=address,undefined -g \
  -I"$probe_dir/main" -I"$IDF_PATH/components/json/cJSON" \
  "$probe_dir/main/probe_wire.c" "$probe_dir/tools/test_wire.c" \
  "$IDF_PATH/components/json/cJSON/cJSON.c" -o "$probe_tmp/wire-test"
"$probe_tmp/wire-test"
