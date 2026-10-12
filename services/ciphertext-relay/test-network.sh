#!/bin/sh
# Actual TLS/Signal/C integration. Native output clocks/routes are synthetic.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
node=$(command -v node)
include=${NODE_INCLUDE_DIR:-$(dirname -- "$(dirname -- "$node")")/include/node}
test -f "$include/node_api.h"
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT HUP INT TERM
${CC:-cc} -std=c11 -Wall -Wextra -Werror -fPIC -shared -pthread \
  -fsanitize=undefined -fno-sanitize-recover=all -fno-omit-frame-pointer \
  -I"$include" -I"$root/native/core/include" \
  "$root/native/integration/pcm_addon.c" "$root/native/core/dae_pcm.c" \
  -lm -o "$build/dae_pcm.node"
DAE_TEST_ADDON="$build/dae_pcm.node" node --test --test-reporter=tap "$root/services/ciphertext-relay/tests/network.integration.mjs"
