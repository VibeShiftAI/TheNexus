#!/bin/sh
# Invoked only inside StorageManagement's child; no default build output path.
set -eu
: "${BUILD_DERIVED_DATA:?Run through StorageManagement/storage.py run}"
: "${BUILD_RESULTS_DIR:?Run through StorageManagement/storage.py run}"
: "${BUILD_ARCHIVES_DIR:?Run through StorageManagement/storage.py run}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
rustc --edition=2021 --test "$script_dir/../src-tauri/src/presentation_policy.rs" \
  -o "$BUILD_DERIVED_DATA/presentation-policy-tests"
"$BUILD_DERIVED_DATA/presentation-policy-tests" > "$BUILD_RESULTS_DIR/presentation-policy-tests.log" 2>&1 || {
  cat "$BUILD_RESULTS_DIR/presentation-policy-tests.log"
  exit 1
}
cat "$BUILD_RESULTS_DIR/presentation-policy-tests.log"
