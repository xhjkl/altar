// Keep release builds from opening a second console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    altar_lib::run()
}
