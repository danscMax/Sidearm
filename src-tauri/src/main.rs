// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // If launched as the capture helper subprocess, run the LL keyboard hook
    // loop instead of the full Tauri application.
    if std::env::args().any(|arg| arg == "--capture-helper") {
        naga_workflow_studio_lib::capture_helper_main();
        return;
    }

    naga_workflow_studio_lib::run()
}
