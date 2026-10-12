#!/bin/sh
# Requires Java 17 and an already licensed Android SDK. Downloads pinned build
# tooling only; never accepts SDK licenses, deploys, signs or publishes an app.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
curl --fail --location --retry 2 --proto '=https' --tlsv1.2 \
  https://services.gradle.org/distributions/gradle-8.13-bin.zip -o "$OUT/gradle.zip"
printf '%s  %s\n' '20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78' "$OUT/gradle.zip" | sha256sum -c -
unzip -q "$OUT/gradle.zip" -d "$OUT"
"$OUT/gradle-8.13/bin/gradle" --no-daemon -p "$HERE" :library:assembleDebug :library:lintDebug "$@"
