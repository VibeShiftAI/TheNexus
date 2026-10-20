#!/bin/sh
# Host-side protocol/JS tests only: never evidence of Windows device behavior.
set -eu
: "${BUILD_DERIVED_DATA:?Run through StorageManagement/storage.py run}"
: "${BUILD_RESULTS_DIR:?Run through StorageManagement/storage.py run}"
: "${BUILD_ARCHIVES_DIR:?Run through StorageManagement/storage.py run}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CARGO_TARGET_DIR="$BUILD_DERIVED_DATA/cargo-target"
harness_dir="$BUILD_DERIVED_DATA/wire-tests"
mkdir -p "$harness_dir"
cat > "$harness_dir/Cargo.toml" <<'TOML'
[package]
name = "nexus-presentation-wire-tests"
version = "0.0.0"
edition = "2021"
[lib]
path = "lib.rs"
[[bin]]
name = "bridge-fixture"
path = "fixture.rs"
[dependencies]
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.150"
TOML
cat > "$harness_dir/lib.rs" <<RUST
#[path = "$script_dir/../src-tauri/src/presentation_policy.rs"]
pub mod presentation_policy;
#[path = "$script_dir/../src-tauri/src/presentation_wire.rs"]
pub mod presentation_wire;
RUST
cat > "$harness_dir/fixture.rs" <<'RUST'
use nexus_presentation_wire_tests::presentation_wire;
fn main() {
    let origin = "https://nexus.vibeshiftai.com";
    println!("{}", serde_json::json!({
        "initialization": presentation_wire::initialization_script(origin),
        "result": presentation_wire::result_script(origin, &serde_json::json!({"requestId":"r-1","ok":true,"sessionId":"s-1","state":"expired"}))
    }));
}
RUST
cargo test --manifest-path "$harness_dir/Cargo.toml" --offline --lib \
  > "$BUILD_RESULTS_DIR/presentation-wire-tests.log" 2>&1 || {
  cat "$BUILD_RESULTS_DIR/presentation-wire-tests.log"
  exit 1
}
cat "$BUILD_RESULTS_DIR/presentation-wire-tests.log"
cargo run --manifest-path "$harness_dir/Cargo.toml" --offline --quiet --bin bridge-fixture \
  > "$BUILD_RESULTS_DIR/presentation-bridge-fixture.json"
node "$script_dir/test-presentation-bridge.cjs" "$BUILD_RESULTS_DIR/presentation-bridge-fixture.json" \
  > "$BUILD_RESULTS_DIR/presentation-bridge-tests.log" 2>&1 || {
  cat "$BUILD_RESULTS_DIR/presentation-bridge-tests.log"
  exit 1
}
cat "$BUILD_RESULTS_DIR/presentation-bridge-tests.log"
