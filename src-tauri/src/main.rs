// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let command = altar_lib::config_command(&arguments);
    match command {
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
        Ok(true) => return,
        Ok(false) => {}
    }
    altar_lib::run()
}
