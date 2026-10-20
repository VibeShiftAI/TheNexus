#!/bin/sh
# Type-check the actual Windows adapter against the locked Tauri API without
# the app's Windows resource build step. This is NOT a full shell build.
set -eu
: "${BUILD_DERIVED_DATA:?Run through StorageManagement/storage.py run}"
: "${BUILD_RESULTS_DIR:?Run through StorageManagement/storage.py run}"
: "${BUILD_ARCHIVES_DIR:?Run through StorageManagement/storage.py run}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CARGO_TARGET_DIR="$BUILD_DERIVED_DATA/cargo-target"
harness_dir="$BUILD_DERIVED_DATA/adapter-check"
mkdir -p "$harness_dir"
cat > "$harness_dir/Cargo.toml" <<'TOML'
[package]
name = "nexus-presentation-adapter-check"
version = "0.0.0"
edition = "2021"
[lib]
path = "lib.rs"
[dependencies]
tauri = { version = "=2.11.5", features = ["tray-icon", "image-png", "unstable"] }
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.150"
TOML
cat > "$harness_dir/lib.rs" <<RUST
#[path = "$script_dir/../src-tauri/src/presentation_policy.rs"]
pub mod presentation_policy;
#[path = "$script_dir/../src-tauri/src/presentation_wire.rs"]
pub mod presentation_wire;
#[path = "$script_dir/../src-tauri/src/presentation.rs"]
pub mod presentation;
RUST
cargo check --manifest-path "$harness_dir/Cargo.toml" --offline --tests \
  --target aarch64-pc-windows-msvc > "$BUILD_RESULTS_DIR/presentation-adapter-check.log" 2>&1 || {
  cat "$BUILD_RESULTS_DIR/presentation-adapter-check.log"
  exit 1
}
cat "$BUILD_RESULTS_DIR/presentation-adapter-check.log"
