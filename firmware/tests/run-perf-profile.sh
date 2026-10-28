#!/usr/bin/env bash
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/cp-perf-tests.XXXXXX")"
trap 'rm -rf -- "$CP_BUILD"' EXIT
for CP_BITS in 32 64; do
    clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
        -DCP_TEST_COUNTER_BITS="$CP_BITS" -I"$CP_FW/tests/perf" \
        -I"$CP_FW/components/cp_perf/include" "$CP_FW/tests/test_perf_profile.c" \
        -o "$CP_BUILD/profile-$CP_BITS"
    "$CP_BUILD/profile-$CP_BITS"
done
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -DCONFIG_CP_PERF_PROFILE=0 -I"$CP_FW/tests/perf" \
    -I"$CP_FW/components/cp_perf/include" "$CP_FW/tests/test_perf_disabled.c" \
    "$CP_FW/components/cp_perf/perf_profile.c" -o "$CP_BUILD/profile-off"
"$CP_BUILD/profile-off"
