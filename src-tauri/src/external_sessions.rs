//! Conversations Claude and Codex started for a project outside MonoCode,
//! listed so they can be read in place. Everything here only reads the
//! providers' files.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::session_store::SessionStore;

const TITLE_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    pub provider: &'static str,
    pub id: String,
    pub title: String,
    /// Which client wrote it, e.g. `claude-desktop` or `cli`.
    pub source: String,
    /// Epoch ms of the transcript's last write.
    pub updated_at: i64,
    pub path: String,
}

#[tauri::command(async)]
pub fn list_external_sessions(
    store: State<'_, SessionStore>,
    cwd: String,
) -> Result<Vec<ExternalSession>, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is required".into());
    }
    let owned = store.provider_session_ids()?;
    let cwd = Path::new(&cwd);
    let mut sessions = list_claude_sessions(&crate::fs::default_claude_config_dir()?, cwd, &owned);
    sessions.extend(list_codex_sessions(&codex_home()?, cwd, &owned));
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

/// The conversation records of one external transcript, trimmed to what the
/// read-only viewer renders. Only files under the provider's own session
/// dirs can be read, so the frontend cannot use this to open arbitrary paths.
#[tauri::command(async)]
pub fn read_external_session(provider: String, path: String) -> Result<Vec<Value>, String> {
    let path = Path::new(&path);
    match provider.as_str() {
        "claude" => {
            let root = crate::fs::default_claude_config_dir()?.join("projects");
            read_claude_records(&checked_transcript_path(&[root], path)?)
        }
        "codex" => {
            let home = codex_home()?;
            let roots = [home.join("sessions"), home.join("archived_sessions")];
            read_codex_records(&checked_transcript_path(&roots, path)?)
        }
        _ => Err("Unknown external session provider".into()),
    }
}

fn checked_transcript_path(roots: &[PathBuf], path: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let inside = roots
        .iter()
        .any(|root| root.canonicalize().is_ok_and(|root| path.starts_with(root)));
    if !inside || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err("Not an external session transcript".into());
    }
    Ok(path)
}

fn read_claude_records(path: &Path) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    Ok(BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(slim_claude_record)
        .collect())
}

/// Keep conversation records only, with the fields the viewer reads. The
/// `toolUseResult` sidecar can hold whole files, so only its presence is
/// kept; inline image bytes are dropped for the same reason.
fn slim_claude_record(record: Value) -> Option<Value> {
    let kind = record.get("type").and_then(Value::as_str)?;
    if (kind != "user" && kind != "assistant")
        || record.get("uuid").is_none()
        || record.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let mut slim = serde_json::Map::new();
    for key in [
        "type",
        "uuid",
        "parentUuid",
        "timestamp",
        "isMeta",
        "origin",
        "apiBlockIndex",
    ] {
        if let Some(value) = record.get(key) {
            slim.insert(key.into(), value.clone());
        }
    }
    if record.get("toolUseResult").is_some() {
        slim.insert("toolUseResult".into(), Value::Bool(true));
    }
    let mut message = serde_json::Map::new();
    for key in ["id", "role", "model"] {
        if let Some(value) = record.pointer(&format!("/message/{key}")) {
            message.insert(key.into(), value.clone());
        }
    }
    if let Some(content) = record.pointer("/message/content") {
        let mut content = content.clone();
        strip_image_data(&mut content);
        message.insert("content".into(), content);
    }
    slim.insert("message".into(), Value::Object(message));
    Some(Value::Object(slim))
}

fn strip_image_data(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(strip_image_data),
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") {
                if let Some(source) = map.get_mut("source").and_then(Value::as_object_mut) {
                    source.remove("data");
                }
            }
            if let Some(content) = map.get_mut("content") {
                strip_image_data(content);
            }
        }
        _ => {}
    }
}

/// Longest folder name Claude writes as is; longer ones get a hash suffix.
const CLAUDE_DIR_NAME_MAX: usize = 200;

/// Claude names a project's folder after its cwd with every non-alphanumeric
/// UTF-16 unit replaced by `-` (it encodes in JavaScript). The mapping is
/// lossy, so each transcript's own `cwd` confirms the match.
fn claude_project_dir_name(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .flat_map(|c| {
            let (c, units) = if c.is_ascii_alphanumeric() {
                (c, 1)
            } else {
                ('-', c.len_utf16())
            };
            std::iter::repeat_n(c, units)
        })
        .collect()
}

/// The project's folder, or for a long cwd every folder Claude may have
/// shortened it to (`<first 200 chars>-<hash>`).
fn claude_project_dirs(projects: &Path, cwd: &Path) -> Vec<PathBuf> {
    let name = claude_project_dir_name(cwd);
    if name.len() <= CLAUDE_DIR_NAME_MAX {
        return vec![projects.join(name)];
    }
    let prefix = &name[..CLAUDE_DIR_NAME_MAX];
    let Ok(entries) = std::fs::read_dir(projects) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix))
        })
        .collect()
}

fn list_claude_sessions(
    config_dir: &Path,
    cwd: &Path,
    owned: &HashSet<String>,
) -> Vec<ExternalSession> {
    claude_project_dirs(&config_dir.join("projects"), cwd)
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flat_map(|entries| entries.flatten())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") || !path.is_file() {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_owned();
            if owned.contains(&id) {
                return None;
            }
            let summary = summarize_claude_transcript(&path, cwd)?;
            let updated_at = modified_ms(&path);
            Some(ExternalSession {
                provider: "claude",
                title: summary.title,
                source: summary.source,
                updated_at,
                path: crate::fs::path_to_js(&path),
                id,
            })
        })
        .collect()
}

struct TranscriptSummary {
    title: String,
    source: String,
}

/// One streaming pass over a transcript: confirm it belongs to `cwd` and pick
/// its title. `None` when it has no real prompt or ran somewhere else.
fn summarize_claude_transcript(path: &Path, cwd: &Path) -> Option<TranscriptSummary> {
    let file = std::fs::File::open(path).ok()?;
    let mut in_project = false;
    // Claude also keeps the current title beside the transcript; with it, the
    // scan can stop at the first prompt instead of reading to the end.
    let saved_title = claude_saved_title(path);
    let mut custom_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut source = String::new();
    // A truncated last line (still being written) just fails to parse.
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if saved_title.is_some() && in_project && first_prompt.is_some() {
            break;
        }
        // Only these records matter; skip parsing the large rest.
        if !line.contains("\"type\":\"user\"") && !line.contains("\"type\":\"custom-title\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(title) = record
                    .get("customTitle")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                {
                    custom_title = Some(title.to_owned());
                }
            }
            Some("user") => {
                if !in_project {
                    in_project = record
                        .get("cwd")
                        .and_then(Value::as_str)
                        .is_some_and(|record_cwd| Path::new(record_cwd).starts_with(cwd));
                }
                if source.is_empty() {
                    if let Some(entrypoint) = record.get("entrypoint").and_then(Value::as_str) {
                        source = entrypoint.to_owned();
                    }
                }
                if first_prompt.is_none() {
                    first_prompt = claude_prompt_text(&record);
                }
            }
            _ => {}
        }
    }
    if !in_project {
        return None;
    }
    let prompt = first_prompt?;
    let title = saved_title
        .or(custom_title)
        .filter(|title| title != "New session")
        .unwrap_or_else(|| clip(&prompt, TITLE_CHARS));
    Some(TranscriptSummary { title, source })
}

fn claude_saved_title(transcript: &Path) -> Option<String> {
    let dir = transcript.with_extension("");
    let text = std::fs::read_to_string(dir.join("custom-title.json")).ok()?;
    let title = serde_json::from_str::<Value>(&text).ok()?;
    let title = title.get("customTitle")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

/// What Claude writes into the user turn when the person stops it.
const CLAUDE_INTERRUPT_PREFIX: &str = "[Request interrupted by user";

/// The text a person typed, or `None` for tool results, injected context, and
/// harness notifications that share the `user` record type. Mirrors
/// `claudePromptText` in claudeTranscript.ts, which renders the transcript.
pub(crate) fn claude_prompt_text(record: &Value) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("user")
        || record.get("isMeta").and_then(Value::as_bool) == Some(true)
        || record.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || record.get("toolUseResult").is_some()
    {
        return None;
    }
    if let Some(kind) = record.pointer("/origin/kind").and_then(Value::as_str) {
        if kind != "human" {
            return None;
        }
    }
    let text = match record.pointer("/message/content")? {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => {
            if blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
            {
                return None;
            }
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty() && !text.starts_with(CLAUDE_INTERRUPT_PREFIX)).then(|| text.to_owned())
}

fn codex_home() -> Result<PathBuf, String> {
    match std::env::var_os("CODEX_HOME") {
        Some(path) => Ok(PathBuf::from(path)),
        None => Ok(
            PathBuf::from(crate::dirs_home().ok_or("Home directory is unavailable")?)
                .join(".codex"),
        ),
    }
}

/// Codex keeps no per-project index: every rollout under `sessions/YYYY/MM/DD`
/// and `archived_sessions/` names its cwd on its first line.
fn codex_rollouts(home: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    walk(&path, depth - 1, out);
                }
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(&home.join("sessions"), 3, &mut out);
    walk(&home.join("archived_sessions"), 0, &mut out);
    out
}

fn list_codex_sessions(home: &Path, cwd: &Path, owned: &HashSet<String>) -> Vec<ExternalSession> {
    let names = codex_thread_names(home);
    codex_rollouts(home)
        .into_iter()
        .filter_map(|path| {
            let meta = codex_session_meta(&path)?;
            let id = meta.get("id").and_then(Value::as_str)?.to_owned();
            let originator = meta.get("originator").and_then(Value::as_str).unwrap_or("");
            let in_project = meta
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|thread_cwd| Path::new(thread_cwd).starts_with(cwd));
            if !in_project
                || !is_top_level_codex_thread(&meta)
                || originator == "monocode"
                || owned.contains(&id)
            {
                return None;
            }
            let title = match names.get(&id) {
                Some(name) => name.clone(),
                None => clip(&first_codex_prompt(&path)?, TITLE_CHARS),
            };
            Some(ExternalSession {
                provider: "codex",
                title,
                source: originator.to_owned(),
                updated_at: modified_ms(&path),
                path: crate::fs::path_to_js(&path),
                id,
            })
        })
        .collect()
}

/// A thread a person started. Guardian reviews and spawned helpers carry
/// `source: {subagent: ...}`; newer rollouts also say so in `thread_source`.
fn is_top_level_codex_thread(meta: &Value) -> bool {
    match meta.get("thread_source").and_then(Value::as_str) {
        Some(thread_source) => thread_source == "user",
        None => !meta
            .get("source")
            .is_some_and(|source| source.get("subagent").is_some()),
    }
}

fn codex_session_meta(path: &Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    let line = BufReader::new(file).lines().next()?.ok()?;
    let mut record = serde_json::from_str::<Value>(&line).ok()?;
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    Some(record.get_mut("payload")?.take())
}

/// Thread names from `session_index.jsonl`; a later line for an id wins.
fn codex_thread_names(home: &Path) -> HashMap<String, String> {
    let Ok(file) = std::fs::File::open(home.join("session_index.jsonl")) else {
        return HashMap::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| {
            let record = serde_json::from_str::<Value>(&line).ok()?;
            let id = record.get("id").and_then(Value::as_str)?;
            let name = record.get("thread_name").and_then(Value::as_str)?.trim();
            (!name.is_empty()).then(|| (id.to_owned(), name.to_owned()))
        })
        .collect()
}

fn first_codex_prompt(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains("UserMessage") || line.contains("user_message"))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .find_map(|record| codex_prompt_text(&record))
}

/// The text a person typed: the clean `UserMessage` item, or the older
/// `user_message` event. Model-facing copies with injected context are skipped.
fn codex_prompt_text(record: &Value) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = record.get("payload")?;
    let text = match payload.get("type").and_then(Value::as_str)? {
        "item_completed" => {
            let item = payload.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("UserMessage") {
                return None;
            }
            item.get("content")?
                .as_array()?
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        }
        "user_message" => payload.get("message").and_then(Value::as_str)?.to_owned(),
        _ => return None,
    };
    // Codex Desktop heads what the person typed with this line, after the IDE
    // and browser context it adds.
    let text = match text.rfind(CODEX_TYPED_PROMPT_MARKER) {
        Some(at) => &text[at + CODEX_TYPED_PROMPT_MARKER.len()..],
        None => text.as_str(),
    }
    .trim();
    (!text.is_empty()).then(|| text.to_owned())
}

const CODEX_TYPED_PROMPT_MARKER: &str = "## My request:";

/// Items the viewer renders. Each appears once, completed, in the
/// `item_completed` stream; the `response_item` layer repeats the same turns
/// with model-facing context mixed in, so it is not read.
const CODEX_ITEM_TYPES: [&str; 8] = [
    "UserMessage",
    "AgentMessage",
    "Reasoning",
    "CommandExecution",
    "FileChange",
    "McpToolCall",
    "DynamicToolCall",
    "ContextCompaction",
];

fn read_codex_records(path: &Path) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    Ok(BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains("\"event_msg\"") || line.contains("\"compacted\""))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(slim_codex_record)
        .collect())
}

fn slim_codex_record(mut record: Value) -> Option<Value> {
    let timestamp = record.get("timestamp").cloned().unwrap_or(Value::Null);
    match record.get("type").and_then(Value::as_str)? {
        // History was rewritten here; the rewrite itself is model-facing.
        "compacted" => {
            return Some(serde_json::json!({"type": "compacted", "timestamp": timestamp}))
        }
        "event_msg" => {}
        _ => return None,
    }
    let mut payload = record.get_mut("payload")?.take();
    match payload.get("type").and_then(Value::as_str)? {
        "item_completed" => {
            let mut item = payload.get_mut("item")?.take();
            let item_type = item.get("type").and_then(Value::as_str)?;
            if !CODEX_ITEM_TYPES.contains(&item_type) {
                return None;
            }
            if let Some(item) = item.as_object_mut() {
                // Split copies of `aggregated_output`.
                for key in ["stdout", "stderr", "formatted_output", "raw_content"] {
                    item.remove(key);
                }
            }
            Some(serde_json::json!({
                "type": "item_completed",
                "timestamp": timestamp,
                "item": item,
            }))
        }
        "user_message" | "agent_message" => Some(serde_json::json!({
            "type": payload.get("type").cloned().unwrap_or(Value::Null),
            "timestamp": timestamp,
            "message": payload.get_mut("message").map(Value::take).unwrap_or(Value::Null),
        })),
        _ => None,
    }
}

fn modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| crate::fs::file_mtime_ms(&meta))
        .map_or(0, |ms| ms as i64)
}

fn clip(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text)
        .trim();
    if line.chars().count() <= max {
        return line.to_owned();
    }
    let mut clipped: String = line.chars().take(max - 1).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::ErrorKind;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        loop {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "monocode-external-{label}-{}-{stamp}-{seq}",
                std::process::id()
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Tmp(dir),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{error}"),
            }
        }
    }

    const PROJECT: &str = "/work/demo-app";

    fn prompt(cwd: &str, text: &str) -> Value {
        json!({"type":"user","cwd":cwd,"entrypoint":"claude-desktop","isSidechain":false,
            "origin":{"kind":"human"},"message":{"role":"user","content":text}})
    }

    fn write_transcript(config: &Path, id: &str, records: &[Value], tail: &str) {
        let dir = config.join("projects").join("-work-demo-app");
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        body.push('\n');
        body.push_str(tail);
        std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
    }

    fn list(config: &Path, owned: &[&str]) -> Vec<ExternalSession> {
        let owned = owned.iter().map(|id| id.to_string()).collect();
        let mut sessions = list_claude_sessions(config, Path::new(PROJECT), &owned);
        sessions.sort_by(|a, b| a.id.cmp(&b.id));
        sessions
    }

    #[test]
    fn encodes_project_folder_like_claude() {
        assert_eq!(
            claude_project_dir_name(Path::new("/home/me/My_App.v2")),
            "-home-me-My-App-v2"
        );
    }

    #[test]
    fn lists_sessions_titled_by_last_custom_title_or_first_prompt() {
        let config = tmp("titles");
        write_transcript(
            &config.0,
            "titled",
            &[
                json!({"type":"custom-title","customTitle":"New session","sessionId":"titled"}),
                prompt(PROJECT, "fix the login bug"),
                json!({"type":"custom-title","customTitle":"Login fix","sessionId":"titled"}),
            ],
            "",
        );
        write_transcript(
            &config.0,
            "untitled",
            &[
                json!({"type":"user","cwd":PROJECT,"isMeta":true,"message":{"content":"injected"}}),
                json!({"type":"user","cwd":PROJECT,"origin":{"kind":"task-notification"},
                    "message":{"content":"<task-notification>"}}),
                prompt(PROJECT, "\n  add a dark mode toggle\nwith details"),
            ],
            // A line cut off mid-write must not hide the session.
            "{\"type\":\"assistant\",\"mess",
        );
        let sessions = list(&config.0, &[]);
        assert_eq!(
            sessions
                .iter()
                .map(|s| (s.id.as_str(), s.title.as_str(), s.source.as_str()))
                .collect::<Vec<_>>(),
            [
                ("titled", "Login fix", "claude-desktop"),
                ("untitled", "add a dark mode toggle", "claude-desktop"),
            ]
        );
        assert!(sessions[0].updated_at > 0);
        assert!(sessions[0].path.ends_with("-work-demo-app/titled.jsonl"));
    }

    #[test]
    fn placeholder_title_falls_back_to_the_prompt() {
        let config = tmp("placeholder");
        write_transcript(
            &config.0,
            "one",
            &[
                prompt(PROJECT, "write tests"),
                json!({"type":"custom-title","customTitle":"New session"}),
            ],
            "",
        );
        assert_eq!(list(&config.0, &[])[0].title, "write tests");
    }

    #[test]
    fn accepts_subfolder_cwd_and_rejects_lookalike_projects() {
        let config = tmp("cwd");
        write_transcript(
            &config.0,
            "sub",
            &[prompt("/work/demo-app/frontend", "hi")],
            "",
        );
        // `/work/demo/app` encodes to the same folder name as `/work/demo-app`.
        write_transcript(&config.0, "other", &[prompt("/work/demo/app", "hi")], "");
        write_transcript(&config.0, "prefix", &[prompt("/work/demo-app2", "hi")], "");
        let ids: Vec<_> = list(&config.0, &[]).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["sub"]);
    }

    #[test]
    fn skips_owned_sessions_tool_results_and_non_transcripts() {
        let config = tmp("skip");
        write_transcript(&config.0, "mine", &[prompt(PROJECT, "hi")], "");
        write_transcript(
            &config.0,
            "tools-only",
            &[json!({"type":"user","cwd":PROJECT,"toolUseResult":{},
                "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}})],
            "",
        );
        write_transcript(
            &config.0,
            "sidechain",
            &[json!({"type":"user","cwd":PROJECT,"isSidechain":true,"message":{"content":"hi"}})],
            "",
        );
        let project = config.0.join("projects/-work-demo-app");
        std::fs::create_dir_all(project.join("mine")).unwrap();
        std::fs::create_dir_all(project.join("memory")).unwrap();
        std::fs::write(project.join("memory/MEMORY.md"), "notes").unwrap();
        assert!(list(&config.0, &["mine"]).is_empty());
    }

    #[test]
    fn prompt_text_joins_text_blocks_and_ignores_images() {
        let record = json!({"type":"user","origin":{"kind":"human"},"message":{"content":[
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
            {"type":"text","text":"what is this?"}
        ]}});
        assert_eq!(
            claude_prompt_text(&record).as_deref(),
            Some("what is this?")
        );
    }

    #[test]
    fn reader_keeps_conversation_records_without_heavy_sidecars() {
        let config = tmp("read");
        write_transcript(
            &config.0,
            "chat",
            &[
                json!({"type":"custom-title","customTitle":"x"}),
                json!({"type":"attachment","uuid":"a0","attachment":{"type":"environment"}}),
                json!({"type":"user","uuid":"u1","cwd":PROJECT,"origin":{"kind":"human"},
                    "message":{"role":"user","content":[
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
                        {"type":"text","text":"look"}]}}),
                json!({"type":"assistant","uuid":"a1","apiBlockIndex":0,"requestId":"r",
                    "message":{"id":"m1","role":"assistant","model":"claude","usage":{"input_tokens":1},
                        "content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x"}}]}}),
                json!({"type":"user","uuid":"u2","toolUseResult":{"originalFile":"huge"},
                    "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}),
                json!({"type":"user","uuid":"s1","isSidechain":true,"message":{"content":"side"}}),
            ],
            "",
        );
        let path = config.0.join("projects/-work-demo-app/chat.jsonl");
        let records = read_claude_records(&path).unwrap();
        assert_eq!(
            records,
            [
                json!({"type":"user","uuid":"u1","origin":{"kind":"human"},
                    "message":{"role":"user","content":[
                        {"type":"image","source":{"type":"base64","media_type":"image/png"}},
                        {"type":"text","text":"look"}]}}),
                json!({"type":"assistant","uuid":"a1","apiBlockIndex":0,
                    "message":{"id":"m1","role":"assistant","model":"claude",
                        "content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x"}}]}}),
                json!({"type":"user","uuid":"u2","toolUseResult":true,
                    "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}),
            ]
        );
    }

    #[test]
    fn reader_refuses_paths_outside_projects() {
        let config = tmp("guard");
        write_transcript(&config.0, "chat", &[prompt(PROJECT, "hi")], "");
        let roots = [config.0.join("projects")];
        let project = roots[0].join("-work-demo-app");
        let outside = config.0.join("secret.jsonl");
        std::fs::write(&outside, "{}").unwrap();
        assert!(checked_transcript_path(&roots, &project.join("chat.jsonl")).is_ok());
        assert!(checked_transcript_path(&roots, &outside).is_err());
        assert!(checked_transcript_path(&roots, &project.join("../../secret.jsonl")).is_err());
        assert!(checked_transcript_path(&roots, &config.0.join("missing.jsonl")).is_err());
    }

    fn session_meta(
        id: &str,
        cwd: &str,
        originator: &str,
        source: Value,
        thread_source: Option<&str>,
    ) -> Value {
        let mut payload = json!({"id":id,"cwd":cwd,"originator":originator,"source":source,
            "base_instructions":{"text":"large"}});
        if let Some(thread_source) = thread_source {
            payload["thread_source"] = json!(thread_source);
        }
        json!({"ordinal":0,"timestamp":"2026-01-02T03:04:05.000Z","type":"session_meta","payload":payload})
    }

    fn item(ordinal: u64, item: Value) -> Value {
        json!({"ordinal":ordinal,"timestamp":"2026-01-02T03:04:06.000Z","type":"event_msg",
            "payload":{"type":"item_completed","thread_id":"t","turn_id":"turn","item":item}})
    }

    fn user_item(text: &str) -> Value {
        item(
            1,
            json!({"type":"UserMessage","id":"u1","content":[{"type":"text","text":text,"text_elements":[]}]}),
        )
    }

    fn write_rollout(home: &Path, dir: &str, id: &str, records: &[Value]) -> PathBuf {
        let dir = home.join(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-01-02T03-04-05-{id}.jsonl"));
        let body = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn lists_top_level_codex_threads_for_the_project() {
        let home = tmp("codex");
        let desktop = json!("vscode");
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "named",
            &[
                session_meta(
                    "named",
                    PROJECT,
                    "Codex Desktop",
                    desktop.clone(),
                    Some("user"),
                ),
                user_item("first prompt"),
            ],
        );
        write_rollout(
            &home.0,
            "archived_sessions",
            "archived",
            &[
                session_meta(
                    "archived",
                    "/work/demo-app/frontend",
                    "codex_cli_rs",
                    desktop.clone(),
                    None,
                ),
                item(
                    1,
                    json!({"type":"AgentMessage","content":[{"type":"Text","text":"hello"}]}),
                ),
                user_item("# In app browser:\n- tab\n\n## My request:\n  tidy the css\nplease"),
            ],
        );
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "old-format",
            &[
                session_meta("old-format", PROJECT, "codex_cli_rs", desktop.clone(), None),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"legacy prompt"}}),
            ],
        );
        // Hidden: helpers, guardian reviews, MonoCode's own threads, other projects.
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "helper",
            &[
                session_meta(
                    "helper",
                    PROJECT,
                    "Codex Desktop",
                    json!({"subagent":{"thread_spawn":{"parent_thread_id":"named","depth":1}}}),
                    Some("subagent"),
                ),
                user_item("x"),
            ],
        );
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "guardian",
            &[
                session_meta(
                    "guardian",
                    PROJECT,
                    "Codex Desktop",
                    json!({"subagent":{"other":"guardian"}}),
                    None,
                ),
                user_item("x"),
            ],
        );
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "ours",
            &[
                session_meta("ours", PROJECT, "monocode", desktop.clone(), Some("user")),
                user_item("x"),
            ],
        );
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "owned",
            &[
                session_meta(
                    "owned",
                    PROJECT,
                    "Codex Desktop",
                    desktop.clone(),
                    Some("user"),
                ),
                user_item("x"),
            ],
        );
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "elsewhere",
            &[
                session_meta(
                    "elsewhere",
                    "/work/demo-app2",
                    "Codex Desktop",
                    desktop.clone(),
                    Some("user"),
                ),
                user_item("x"),
            ],
        );
        write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "silent",
            &[session_meta(
                "silent",
                PROJECT,
                "Codex Desktop",
                desktop,
                Some("user"),
            )],
        );
        std::fs::write(
            home.0.join("session_index.jsonl"),
            [
                json!({"id":"named","thread_name":"Old name","updated_at":"x"}),
                json!({"id":"named","thread_name":"Refactor auth","updated_at":"y"}),
            ]
            .map(|line| line.to_string())
            .join("\n"),
        )
        .unwrap();
        let owned = HashSet::from(["owned".to_string()]);
        let mut sessions = list_codex_sessions(&home.0, Path::new(PROJECT), &owned);
        sessions.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            sessions
                .iter()
                .map(|s| (
                    s.provider,
                    s.id.as_str(),
                    s.title.as_str(),
                    s.source.as_str()
                ))
                .collect::<Vec<_>>(),
            [
                ("codex", "archived", "tidy the css", "codex_cli_rs"),
                ("codex", "named", "Refactor auth", "Codex Desktop"),
                ("codex", "old-format", "legacy prompt", "codex_cli_rs"),
            ]
        );
    }

    #[test]
    fn codex_reader_keeps_rendered_items_only() {
        let home = tmp("codex-read");
        let path = write_rollout(
            &home.0,
            "sessions/2026/01/02",
            "chat",
            &[
                session_meta(
                    "chat",
                    PROJECT,
                    "Codex Desktop",
                    json!("vscode"),
                    Some("user"),
                ),
                json!({"type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":"<environment_context>"}]}}),
                user_item("run tests"),
                item(
                    2,
                    json!({"type":"CommandExecution","id":"c1","command":"npm test",
                "aggregated_output":"ok","stdout":"ok","stderr":"","formatted_output":"ok",
                "exit_code":0,"status":"completed"}),
                ),
                item(3, json!({"type":"SubAgentActivity","agent_path":"/root/x"})),
                json!({"type":"event_msg","payload":{"type":"token_count","info":{}}}),
                json!({"type":"compacted","timestamp":"t","payload":{"replacement_history":[{"big":true}]}}),
            ],
        );
        let records = read_codex_records(&path).unwrap();
        let kinds: Vec<_> = records
            .iter()
            .map(|record| {
                record
                    .pointer("/item/type")
                    .or_else(|| record.get("type"))
                    .unwrap()
                    .as_str()
                    .unwrap()
            })
            .collect();
        assert_eq!(kinds, ["UserMessage", "CommandExecution", "compacted"]);
        assert_eq!(
            records[1]["item"],
            json!({"type":"CommandExecution","id":"c1","command":"npm test",
                "aggregated_output":"ok","exit_code":0,"status":"completed"})
        );
        assert_eq!(records[2], json!({"type":"compacted","timestamp":"t"}));
    }

    #[test]
    fn encodes_astral_characters_as_two_units_like_claude() {
        assert_eq!(claude_project_dir_name(Path::new("/a/😀b")), "-a---b");
    }

    #[test]
    fn finds_shortened_folders_for_long_project_paths() {
        let config = tmp("long");
        let long = format!("/work/{}", "x".repeat(240));
        let name = claude_project_dir_name(Path::new(&long));
        let dir = config
            .0
            .join("projects")
            .join(format!("{}-1abc", &name[..200]));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chat.jsonl"), prompt(&long, "hi").to_string()).unwrap();
        let sessions = list_claude_sessions(&config.0, Path::new(&long), &HashSet::new());
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn saved_title_file_wins_and_interrupts_are_not_prompts() {
        let config = tmp("saved");
        write_transcript(
            &config.0,
            "chat",
            &[
                json!({"type":"user","cwd":PROJECT,"message":{"content":"[Request interrupted by user]"}}),
                json!({"type":"user","cwd":PROJECT,"message":{"content":[
                    {"type":"tool_result","tool_use_id":"t","content":"x"},
                    {"type":"text","text":"hook feedback"}]}}),
                prompt(PROJECT, "real prompt"),
            ],
            "",
        );
        let sessions = list(&config.0, &[]);
        assert_eq!(sessions[0].title, "real prompt");
        let side = config.0.join("projects/-work-demo-app/chat");
        std::fs::create_dir_all(&side).unwrap();
        std::fs::write(side.join("custom-title.json"), r#"{"customTitle":"Saved"}"#).unwrap();
        assert_eq!(list(&config.0, &[])[0].title, "Saved");
    }

    #[test]
    fn missing_project_folder_lists_nothing() {
        let config = tmp("missing");
        assert!(list(&config.0, &[]).is_empty());
    }
}
