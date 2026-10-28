fn main() {
    // `host_invoke` is the only command her pages may call; the capabilities grant it per window.
    let app = tauri_build::AppManifest::new().commands(&["host_invoke"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app)).expect("tauri build");
    // the sidecar and the page files are not Cargo inputs: rebuild when the staged frontend changes
    println!("cargo:rerun-if-changed=frontend");
    println!("cargo:rerun-if-changed=tauri.conf.json");
}
