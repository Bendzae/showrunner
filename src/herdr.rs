//! Showrunner in the Herdr app: its mods (the sidebar tree and its popups,
//! the status bar), a layout using them, and the key that moves between the
//! tree and the terminals, written into a Herdr home (`~/.config/herdr-app`).
//! They ship inside the binary so they always match the CLI they call.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{Value, json};

macro_rules! files {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_str!(concat!("../herdr/", $path)))),*]
    };
}

const FILES: &[(&str, &str)] = files![
    "layouts/showrunner.json",
    "mods/showrunner/mod.json",
    "mods/showrunner/main.js",
    "mods/showrunner/lib.js",
    "mods/showrunner/actions.js",
    "mods/showrunner/tree.js",
    "mods/showrunner/overlays.js",
    "mods/showrunner/ui.js",
    "mods/showrunner/icons/archive.svg",
    "mods/showrunner/icons/check.svg",
    "mods/showrunner/icons/chevron-down.svg",
    "mods/showrunner/icons/chevron-right.svg",
    "mods/showrunner/icons/diamond.svg",
    "mods/showrunner/icons/folder-plus.svg",
    "mods/showrunner/icons/folder.svg",
    "mods/showrunner/icons/git-branch.svg",
    "mods/showrunner/icons/house.svg",
    "mods/showrunner/icons/layers.svg",
    "mods/showrunner/icons/play.svg",
    "mods/showrunner/icons/plus.svg",
    "mods/showrunner/icons/search.svg",
    "mods/showrunner/icons/spinner.svg",
    "mods/showrunner-status/mod.json",
    "mods/showrunner-status/main.js",
];

/// The key, in the layout's own section: `Ctrl-/` jumps between the tree and
/// the terminal.
const KEY_SECTION: &str = "layout:showrunner";
const KEY: &str = "ctrl-/";
const KEY_ACTION: &str = "showrunner.toggle";

pub fn default_home() -> PathBuf {
    std::env::var_os("HERDR_APP_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".config/herdr-app")
        })
}

/// What `install` did, line by line.
pub struct Installed {
    pub notes: Vec<String>,
}

/// Write the mods and the layout into `home`. With `bin`, the mods run that
/// binary instead of `showrunner` from the PATH (a build installed under
/// another name). With `keys`, `Ctrl-\` is bound in `keys.json`.
pub fn install(home: &Path, bin: Option<&str>, keys: bool) -> Result<Installed> {
    if !home.is_dir() {
        anyhow::bail!(
            "{} doesn't exist: open Herdr once first (or pass --home)",
            home.display()
        );
    }
    let mut notes = Vec::new();
    for (path, text) in FILES {
        let target = home.join(path);
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&target, text).with_context(|| format!("writing {}", target.display()))?;
    }
    notes.push(format!(
        "mods showrunner and showrunner-status, layout showrunner → {}",
        home.display()
    ));

    let local = home.join("mods/showrunner/local.json");
    let showrunner_home = std::env::var_os("SHOWRUNNER_HOME").map(PathBuf::from);
    if bin.is_some() || showrunner_home.is_some() {
        let mut config = json!({});
        if let Some(bin) = bin {
            config["bin"] = json!(bin);
        }
        if let Some(dir) = &showrunner_home {
            config["home"] = json!(dir);
        }
        fs::write(&local, serde_json::to_string_pretty(&config)? + "\n")?;
        notes.push(format!("the mods run {}", bin.unwrap_or("showrunner")));
    } else if local.exists() {
        fs::remove_file(&local)?;
    }

    if keys {
        let path = home.join("keys.json");
        let text = fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
        let mut map: Value =
            serde_json::from_str(&text).with_context(|| format!("reading {}", path.display()))?;
        if map.get(KEY_SECTION).is_none() {
            map[KEY_SECTION] = json!({});
        }
        let section = map[KEY_SECTION]
            .as_object_mut()
            .context("keys.json section")?;
        let before = section.clone();
        // A key an earlier install bound to the toggle goes: one key does it.
        section.retain(|key, action| key == KEY || action.as_str() != Some(KEY_ACTION));
        section.insert(KEY.to_string(), json!(KEY_ACTION));
        if *section != before {
            fs::write(&path, serde_json::to_string_pretty(&map)? + "\n")?;
            notes.push(
                "keys.json: ctrl-/ jumps between the tree and the terminal in the Showrunner \
                 layout (Herdr no longer updates an edited keys.json's defaults: add new ones \
                 by hand)"
                    .to_string(),
            );
        }
    }
    Ok(Installed { notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_and_mod_manifests_are_json() {
        for (path, text) in FILES {
            if path.ends_with(".json") {
                serde_json::from_str::<Value>(text).unwrap_or_else(|e| panic!("{path}: {e}"));
            }
        }
    }

    #[test]
    fn install_writes_files_and_merges_the_key() {
        let home = std::env::temp_dir().join(format!("sr-herdr-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("keys.json"),
            r#"{"global":{"cmd-t":"tab.new"},"layout:showrunner":{"ctrl-\\":"showrunner.toggle"}}"#,
        )
        .unwrap();

        install(&home, Some("/opt/sr"), true).unwrap();
        install(&home, Some("/opt/sr"), true).unwrap();

        assert!(home.join("mods/showrunner/tree.js").is_file());
        assert!(home.join("layouts/showrunner.json").is_file());
        let keys: Value =
            serde_json::from_str(&fs::read_to_string(home.join("keys.json")).unwrap()).unwrap();
        assert_eq!(keys["global"]["cmd-t"], "tab.new");
        assert_eq!(keys[KEY_SECTION][KEY], KEY_ACTION);
        assert_eq!(keys[KEY_SECTION].as_object().unwrap().len(), 1);
        let local: Value = serde_json::from_str(
            &fs::read_to_string(home.join("mods/showrunner/local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(local["bin"], "/opt/sr");
        fs::remove_dir_all(&home).unwrap();
    }
}
