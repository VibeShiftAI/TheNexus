#!/bin/sh
# Cross-check only. A successful check is not Windows runtime/hardware proof.
set -eu
: "${BUILD_DERIVED_DATA:?Run through StorageManagement/storage.py run}"
: "${BUILD_RESULTS_DIR:?Run through StorageManagement/storage.py run}"
: "${BUILD_ARCHIVES_DIR:?Run through StorageManagement/storage.py run}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CARGO_TARGET_DIR="$BUILD_DERIVED_DATA/cargo-target"
cargo check --manifest-path "$script_dir/../src-tauri/Cargo.toml" --locked --offline \
  --target aarch64-pc-windows-msvc > "$BUILD_RESULTS_DIR/presentation-windows-check.log" 2>&1 || {
  cat "$BUILD_RESULTS_DIR/presentation-windows-check.log"
  exit 1
}
cat "$BUILD_RESULTS_DIR/presentation-windows-check.log"
