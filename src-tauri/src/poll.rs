// poll.rs — Poll engine: keywords, counts, state machine
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPoll {
    pub id: String,
    pub name: String,
    pub config: PollConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollHistoryEntry {
    pub id: String,
    pub timestamp: u64,        // Unix ms
    pub question: String,
    pub results: Vec<PollOptionResult>,
    pub total_votes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOption {
    pub id: String,
    pub label: String,
    pub keywords: Vec<String>,
    pub color: String,
    pub votes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollConfig {
    pub question: String,
    pub options: Vec<PollOption>,
    pub case_insensitive: bool,
    pub one_vote_per_user: bool,
}

impl Default for PollConfig {
    fn default() -> Self {
        Self {
            question: "What do you think?".to_string(),
            options: vec![
                PollOption {
                    id: "opt1".to_string(),
                    label: "Option A".to_string(),
                    keywords: vec!["a".to_string(), "1".to_string()],
                    color: "#6c63ff".to_string(),
                    votes: 0,
                },
                PollOption {
                    id: "opt2".to_string(),
                    label: "Option B".to_string(),
                    keywords: vec!["b".to_string(), "2".to_string()],
                    color: "#ff6584".to_string(),
                    votes: 0,
                },
            ],
            case_insensitive: true,
            one_vote_per_user: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PollStatus {
    Idle,
    Running,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOptionResult {
    pub id: String,
    pub label: String,
    pub votes: u64,
    pub percentage: f64,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollUpdate {
    pub question: String,
    pub options: Vec<PollOptionResult>,
    pub total_votes: u64,
    pub status: String,
}

pub struct PollState {
    pub config: PollConfig,
    pub status: PollStatus,
    pub total_votes: u64,
    pub voted_users: HashMap<String, String>, // user_id -> option_id they voted for
}

impl Default for PollState {
    fn default() -> Self {
        Self {
            config: PollConfig::default(),
            status: PollStatus::Idle,
            total_votes: 0,
            voted_users: HashMap::new(),
        }
    }
}

impl PollState {
    pub fn reset_votes(&mut self) {
        for option in &mut self.config.options {
            option.votes = 0;
        }
        self.total_votes = 0;
        self.voted_users.clear();
    }

    pub fn process_message(&mut self, author: &str, text: &str) -> Option<PollUpdate> {
        if self.status != PollStatus::Running {
            return None;
        }

        // Check one-vote-per-user
        if self.config.one_vote_per_user && self.voted_users.contains_key(author) {
            return None;
        }

        let text_to_match = if self.config.case_insensitive {
            text.to_lowercase()
        } else {
            text.to_string()
        };

        // Find matching option — whole-word keyword match
        let mut matched_option_id: Option<String> = None;
        for option in &self.config.options {
            for keyword in &option.keywords {
                let kw = if self.config.case_insensitive {
                    keyword.to_lowercase()
                } else {
                    keyword.clone()
                };
                // Check if message is exactly the keyword or contains it as a whole word
                if is_keyword_match(&text_to_match, &kw) {
                    matched_option_id = Some(option.id.clone());
                    break;
                }
            }
            if matched_option_id.is_some() {
                break;
            }
        }

        if let Some(opt_id) = matched_option_id {
            // Increment vote
            if let Some(option) = self.config.options.iter_mut().find(|o| o.id == opt_id) {
                option.votes += 1;
                self.total_votes += 1;
                if self.config.one_vote_per_user {
                    self.voted_users.insert(author.to_string(), opt_id);
                }
                return Some(self.build_update());
            }
        }

        None
    }

    pub fn build_update(&self) -> PollUpdate {
        let total = self.total_votes;
        let options = self
            .config
            .options
            .iter()
            .map(|o| PollOptionResult {
                id: o.id.clone(),
                label: o.label.clone(),
                votes: o.votes,
                percentage: if total > 0 {
                    (o.votes as f64 / total as f64) * 100.0
                } else {
                    0.0
                },
                color: o.color.clone(),
            })
            .collect();

        PollUpdate {
            question: self.config.question.clone(),
            options,
            total_votes: total,
            status: match self.status {
                PollStatus::Idle => "idle".to_string(),
                PollStatus::Running => "running".to_string(),
                PollStatus::Paused => "paused".to_string(),
            },
        }
    }
}

/// Check if `keyword` is a whole-word match within `text`
fn is_keyword_match(text: &str, keyword: &str) -> bool {
    let trimmed = text.trim();
    // Exact match
    if trimmed == keyword {
        return true;
    }
    // Whole-word match using word boundaries
    let mut start = 0;
    while let Some(pos) = text[start..].find(keyword) {
        let abs_pos = start + pos;
        let before_ok = abs_pos == 0
            || !text
                .as_bytes()
                .get(abs_pos - 1)
                .map(|c| c.is_ascii_alphanumeric() || *c == b'_')
                .unwrap_or(false);
        let end_pos = abs_pos + keyword.len();
        let after_ok = end_pos >= text.len()
            || !text
                .as_bytes()
                .get(end_pos)
                .map(|c| c.is_ascii_alphanumeric() || *c == b'_')
                .unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        start = abs_pos + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exact_keyword_match() {
        assert!(is_keyword_match("a", "a"));
        assert!(is_keyword_match("yes", "yes"));
    }

    #[test]
    fn test_word_in_sentence() {
        assert!(is_keyword_match("i vote a", "a"));
        assert!(is_keyword_match("definitely yes!", "yes"));
    }

    #[test]
    fn test_no_partial_match() {
        assert!(!is_keyword_match("awesome", "a"));
        assert!(!is_keyword_match("yesss", "yes"));
    }

    #[test]
    fn test_case_insensitive_processing() {
        let mut state = PollState::default();
        state.status = PollStatus::Running;
        let result = state.process_message("user1", "A");
        assert!(result.is_some());
        let update = result.unwrap();
        assert_eq!(update.options[0].votes, 1);
    }

    #[test]
    fn test_one_vote_per_user() {
        let mut state = PollState::default();
        state.status = PollStatus::Running;
        state.process_message("user1", "a");
        let second = state.process_message("user1", "b");
        assert!(second.is_none());
        assert_eq!(state.total_votes, 1);
    }

    #[test]
    fn test_paused_state_no_votes() {
        let mut state = PollState::default();
        state.status = PollStatus::Paused;
        let result = state.process_message("user1", "a");
        assert!(result.is_none());
    }
}
