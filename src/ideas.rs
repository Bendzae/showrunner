//! The idea queue: what the person wants a task's sessions to do later, kept
//! per task (an adhoc session's: per project). The Herdr app's Ideas panel and
//! the agents (the `idea-queue` skill) share it through `showrunner ideas`.

use std::fs;
use std::path::PathBuf;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::{self, SessionRecord};
use crate::session;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Idea {
    pub id: String,
    pub text: String,
    /// Sent to a session on its own: it comes to the agent as a prompt.
    #[serde(default)]
    pub sent: bool,
    /// An agent has started on it.
    #[serde(default)]
    pub started: bool,
}

/// The queue a session's ideas go in: its task's, or its project's for an
/// adhoc session.
pub fn queue_path(record: &SessionRecord) -> PathBuf {
    let slot = if session::is_adhoc_marker(&record.task_name) {
        session::ADHOC_MARKER
    } else {
        record.task_branch.as_str()
    };
    config::task_dir(&record.project_name, slot).join("ideas.json")
}

pub fn load(path: &PathBuf) -> Vec<Idea> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write the queue whole: through a temporary file, so a reader never sees
/// half of it.
pub fn save(path: &PathBuf, ideas: &[Idea]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(ideas)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn new_idea(text: &str) -> Idea {
    Idea {
        id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        text: text.trim().to_string(),
        sent: false,
        started: false,
    }
}

/// The queue as an agent reads it: numbered, in the order added.
pub fn describe(ideas: &[Idea]) -> String {
    if ideas.is_empty() {
        return "The idea queue is empty.".to_string();
    }
    let lines: Vec<String> = ideas
        .iter()
        .enumerate()
        .map(|(i, idea)| {
            let state = if idea.started {
                " (started)"
            } else if idea.sent {
                " (sent to a session on its own, coming up)"
            } else {
                ""
            };
            format!("{}. [id {}]{state} {}", i + 1, idea.id, idea.text)
        })
        .collect();
    format!(
        "Queued ideas, in the order they were added (not an order to do them in):\n{}",
        lines.join("\n")
    )
}

/// Change one idea of the queue; an unknown id is an error naming the way to
/// the ids.
pub fn change(ideas: &mut Vec<Idea>, id: &str, how: Change) -> Result<()> {
    let Some(i) = ideas.iter().position(|idea| idea.id == id) else {
        bail!("no queued idea has the id {id} (see `showrunner ideas list`)");
    };
    match how {
        Change::Start => ideas[i].started = true,
        Change::Sent => ideas[i].sent = true,
        Change::Edit(text) => ideas[i].text = text.trim().to_string(),
        Change::Remove => {
            ideas.remove(i);
        }
    }
    Ok(())
}

pub enum Change {
    Start,
    Sent,
    Edit(String),
    /// Done, or dropped: either way it leaves the queue.
    Remove,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> Vec<Idea> {
        vec![new_idea("add tests"), new_idea("rename the flag")]
    }

    #[test]
    fn changes_mark_and_remove_ideas_by_id() {
        let mut ideas = queue();
        let first = ideas[0].id.clone();
        change(&mut ideas, &first, Change::Start).unwrap();
        assert!(ideas[0].started);
        change(&mut ideas, &first, Change::Edit(" add more tests ".into())).unwrap();
        assert_eq!(ideas[0].text, "add more tests");
        change(&mut ideas, &first, Change::Remove).unwrap();
        assert_eq!(ideas.len(), 1);
        assert!(change(&mut ideas, "nope", Change::Remove).is_err());
    }

    #[test]
    fn description_numbers_ideas_and_says_their_state() {
        let mut ideas = queue();
        ideas[1].sent = true;
        let text = describe(&ideas);
        assert!(text.contains(&format!("1. [id {}] add tests", ideas[0].id)));
        assert!(text.contains("(sent to a session on its own, coming up) rename the flag"));
        assert_eq!(describe(&[]), "The idea queue is empty.");
    }
}
