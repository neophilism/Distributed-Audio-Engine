#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
: "${JAVA_HOME:=$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")}"
cc -std=c11 -shared -fPIC -pthread -Wall -Wextra -Wpedantic -Werror \
  -I"$JAVA_HOME/include" -I"$JAVA_HOME/include/linux" -I"$ROOT/native/core/include" \
  "$ROOT/native/core/dae_pcm.c" "$ROOT/native/android/library/src/main/cpp/native_pcm_jni.c" \
  -lm -o "$OUT/libdae_audio_jni.so"
javac --release 17 -Xlint:all -Werror -d "$OUT" \
  "$ROOT/native/android/library/src/main/java/org/neophilism/dae/NativePcm.java" \
  "$ROOT/native/android/library/src/main/java/org/neophilism/dae/FrameClock.java" \
  "$ROOT/native/android/tests/NativePcmTest.java"
java -ea -Djava.library.path="$OUT" -cp "$OUT" org.neophilism.dae.NativePcmTest
