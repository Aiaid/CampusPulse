#!/usr/bin/env bash
set -euo pipefail
T="$(cd -- "$(dirname -- "$0")" && pwd)"
P="$(cd -- "$T/.." && pwd)"
F="$(cd -- "$P/../.." && pwd)"
O="$(mktemp -d "${TMPDIR:-/tmp}/te-identity.XXXXXX")"
trap 'rm -rf -- "$O"' EXIT
read -r -a CRYPTO <<< "$(pkg-config --cflags --libs openssl)"
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
  -I "$P" -I "$F/components/cp_v3_budget/include" \
  "$T/test_identity.c" "$P/identity.c" "$F/components/cp_v3_budget/budget.c" \
  "${CRYPTO[@]}" -lz -o "$O/test"
"$O/test"
