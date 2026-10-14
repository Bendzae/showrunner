//! macOS notifications, posted in the background so the caller never waits.

use std::process::{Command, Stdio};
use std::thread;

/// Post a notification: through `terminal-notifier` when installed (a click
/// brings the terminal forward), else `osascript`. Does nothing off macOS.
pub fn post(title: &str, subtitle: &str, message: &str) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let mut command = if has_terminal_notifier() {
        let mut command = Command::new("terminal-notifier");
        command.args(["-title", title, "-subtitle", subtitle, "-message", message]);
        if let Ok(terminal) = std::env::var("__CFBundleIdentifier") {
            command.args(["-activate", &terminal]);
        }
        command
    } else {
        let mut command = Command::new("osascript");
        command.args([
            "-e",
            &format!(
                "display notification {} with title {} subtitle {}",
                applescript_string(message),
                applescript_string(title),
                applescript_string(subtitle),
            ),
        ]);
        command
    };
    command.stdout(Stdio::null()).stderr(Stdio::null());
    thread::spawn(move || {
        let _ = command.status();
    });
}

fn has_terminal_notifier() -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| dir.join("terminal-notifier").is_file())
    })
}

fn applescript_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_string_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }
}
