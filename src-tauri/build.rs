fn main() {
    // Use uiAccess="true" manifest only for signed release builds.
    // In dev/debug mode, uiAccess="true" causes ERROR_ELEVATION_REQUIRED (740)
    // because the exe is neither signed nor in a secure location.
    let manifest = if std::env::var("SIDEARM_UIACCESS").as_deref() == Ok("true") {
        include_str!("manifest-uiaccess.xml")
    } else {
        include_str!("manifest.xml")
    };

    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
