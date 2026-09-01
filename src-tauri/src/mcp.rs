//! Embedded MCP server: a stateless Streamable-HTTP endpoint on 127.0.0.1 that
//! exposes the notes to MCP clients (Claude Code, Cursor, …). Hand-rolled
//! JSON-RPC over axum — the surface is four methods and five tools, and the
//! approval flow (a tool call blocking on a oneshot until the user clicks
//! Approve in the panel) is simpler here than through an SDK's tool router.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::State as AxumState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// Deliberately obscure port block — clear of dev-server staples (3000, 8080,
/// 5173, 1420, …) and other tools' MCP ports (Figma's 3845). If the first is
/// taken, the next few are tried; the frontend shows whichever URL was bound.
const PORT_RANGE: std::ops::RangeInclusive<u16> = 41820..=41829;
const PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
/// Shorter than any client's own tool-call timeout, so the client always gets
/// our "timed out" tool error rather than hanging into its own deadline.
const APPROVAL_TIMEOUT_SECS: u64 = 60;

// ---- state ----------------------------------------------------------------

#[derive(Default)]
pub struct McpState(Mutex<McpInner>);

#[derive(Default)]
struct McpInner {
    server: Option<ServerHandle>,
    approvals: HashMap<u64, PendingApproval>,
    next_approval_id: u64,
    /// Tools the user chose "Always allow" for. Lives for the app run, not the
    /// server session — restarting the server doesn't re-prompt.
    session_allow: HashSet<String>,
}

struct ServerHandle {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

struct PendingApproval {
    tool: String,
    tx: oneshot::Sender<bool>,
}

// ---- lifecycle commands ---------------------------------------------------

#[tauri::command]
pub async fn start_mcp(app: AppHandle, state: State<'_, McpState>) -> Result<u16, String> {
    if let Some(handle) = state.0.lock().unwrap().server.as_ref() {
        return Ok(handle.port);
    }

    let mut bound = None;
    for port in PORT_RANGE {
        if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            bound = Some((listener, port));
            break;
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!(
            "no free port between {} and {}",
            PORT_RANGE.start(),
            PORT_RANGE.end()
        )
    })?;

    let router = Router::new()
        .route(
            "/mcp",
            post(handle_mcp).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .with_state(app.clone());

    let (shutdown, rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    state.0.lock().unwrap().server = Some(ServerHandle { port, shutdown });
    Ok(port)
}

#[tauri::command]
pub fn stop_mcp(state: State<'_, McpState>) {
    let (server, pending) = {
        let mut inner = state.0.lock().unwrap();
        let pending: Vec<_> = inner.approvals.drain().collect();
        (inner.server.take(), pending)
    };
    if let Some(handle) = server {
        let _ = handle.shutdown.send(());
    }
    // Deny in-flight approval requests immediately instead of stranding their
    // tool calls until the timeout.
    for (_, approval) in pending {
        let _ = approval.tx.send(false);
    }
}

/// Running port, if any. The frontend calls this on mount to resync — in dev a
/// Vite HMR reload remounts React while the Rust server keeps running.
#[tauri::command]
pub fn mcp_status(state: State<'_, McpState>) -> Option<u16> {
    state.0.lock().unwrap().server.as_ref().map(|s| s.port)
}

#[tauri::command]
pub fn respond_mcp_approval(state: State<'_, McpState>, id: u64, approve: bool, always: bool) {
    // Absent entry means the request already timed out or the server stopped —
    // a late click is a no-op.
    let pending = {
        let mut inner = state.0.lock().unwrap();
        let pending = inner.approvals.remove(&id);
        if approve && always {
            if let Some(p) = &pending {
                inner.session_allow.insert(p.tool.clone());
            }
        }
        pending
    };
    if let Some(p) = pending {
        let _ = p.tx.send(approve);
    }
}

// ---- JSON-RPC dispatch ----------------------------------------------------

async fn handle_mcp(
    AxumState(app): AxumState<AppHandle>,
    headers: HeaderMap,
    body: String,
) -> Response {
    // DNS-rebinding guard (required by the MCP spec): a browser page on an
    // attacker's domain can reach 127.0.0.1 but can't hide its Origin. CLI
    // clients send no Origin header and pass through.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        if !origin_allowed(origin) {
            return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
        }
    }

    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return rpc_error(StatusCode::BAD_REQUEST, Value::Null, -32700, "parse error"),
    };
    if msg.is_array() {
        return rpc_error(
            StatusCode::BAD_REQUEST,
            Value::Null,
            -32600,
            "batch requests are not supported",
        );
    }

    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    // Notifications (and client-side responses, which have no method) get 202.
    if id.is_null() || method.is_empty() {
        return StatusCode::ACCEPTED.into_response();
    }

    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let outcome = match method {
        "initialize" => Ok(initialize_result(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list()),
        "tools/call" => handle_tools_call(&app, &params).await,
        _ => Err((-32601, format!("method not found: {method}"))),
    };

    match outcome {
        Ok(result) => Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response(),
        Err((code, message)) => rpc_error(StatusCode::OK, id, code, &message),
    }
}

fn rpc_error(status: StatusCode, id: Value, code: i64, message: &str) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    });
    (status, Json(body)).into_response()
}

fn origin_allowed(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    let host = rest.rsplit_once(':').map(|(h, _)| h).unwrap_or(rest);
    host == "127.0.0.1" || host == "localhost" || host == "[::1]"
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let version = if PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        LATEST_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "memotepad", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Memotepad notes are markdown files identified by id. Use list_notes to browse, read_note before editing, and write_note to replace a note's full content. create_note and delete_note require the user to approve in the Memotepad window.",
    })
}

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "list_notes",
                "description": "List all notes with id, title, preview, and last-modified time (unix millis), newest first.",
                "inputSchema": { "type": "object", "properties": {} },
            },
            {
                "name": "read_note",
                "description": "Read the full markdown content of a note.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "id": { "type": "string", "description": "Note id from list_notes" } },
                    "required": ["id"],
                },
            },
            {
                "name": "write_note",
                "description": "Replace the entire markdown content of an existing note. This overwrites the note — read it first and send the complete new content.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Note id from list_notes" },
                        "content": { "type": "string", "description": "Complete new markdown content" },
                    },
                    "required": ["id", "content"],
                },
            },
            {
                "name": "create_note",
                "description": "Create a new note, optionally with initial markdown content. Requires user approval in the Memotepad window.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "content": { "type": "string", "description": "Optional initial markdown content" } },
                },
            },
            {
                "name": "delete_note",
                "description": "Permanently delete a note. Requires user approval in the Memotepad window.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "id": { "type": "string", "description": "Note id from list_notes" } },
                    "required": ["id"],
                },
            },
        ],
    })
}

// ---- tools ----------------------------------------------------------------

enum ToolError {
    /// Malformed arguments → JSON-RPC -32602.
    InvalidParams(String),
    /// Domain failure (not found, denied, fs error) → tool result with isError.
    Failed(String),
}

async fn handle_tools_call(app: &AppHandle, params: &Value) -> Result<Value, (i64, String)> {
    let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
        return Err((-32602, "missing tool name".to_string()));
    };
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    let outcome = match name {
        "list_notes" => tool_list_notes(app),
        "read_note" => tool_read_note(app, &args),
        "write_note" => tool_write_note(app, &args),
        "create_note" => tool_create_note(app, &args).await,
        "delete_note" => tool_delete_note(app, &args).await,
        _ => return Err((-32602, format!("unknown tool: {name}"))),
    };

    match outcome {
        Ok(text) => Ok(json!({ "content": [{ "type": "text", "text": text }] })),
        Err(ToolError::InvalidParams(msg)) => Err((-32602, msg)),
        Err(ToolError::Failed(msg)) => Ok(json!({
            "content": [{ "type": "text", "text": msg }],
            "isError": true,
        })),
    }
}

fn arg_str(args: &Value, key: &str) -> Result<String, ToolError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| ToolError::InvalidParams(format!("missing required argument: {key}")))
}

fn tool_list_notes(app: &AppHandle) -> Result<String, ToolError> {
    let _ = crate::migrate_legacy(app);
    let dir = crate::notes_dir(app).map_err(ToolError::Failed)?;
    fs::create_dir_all(&dir).map_err(|e| ToolError::Failed(e.to_string()))?;

    // Same walk as the list_notes command, but a lean shape for an LLM —
    // NoteMeta's `body` is a lowercased search blob and doesn't belong here.
    let mut notes: Vec<(u64, Value)> = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|e| ToolError::Failed(e.to_string()))?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        let (title, preview) = crate::derive(&content);
        let modified = crate::modified_millis(&path);
        notes.push((
            modified,
            json!({ "id": id, "title": title, "preview": preview, "modified": modified }),
        ));
    }
    notes.sort_by(|a, b| b.0.cmp(&a.0));
    let list: Vec<Value> = notes.into_iter().map(|(_, v)| v).collect();
    serde_json::to_string_pretty(&list).map_err(|e| ToolError::Failed(e.to_string()))
}

fn tool_read_note(app: &AppHandle, args: &Value) -> Result<String, ToolError> {
    let id = arg_str(args, "id")?;
    let path = crate::note_file(app, &id).map_err(ToolError::Failed)?;
    // Unlike the read_note command (which returns "" so the UI can open a
    // just-created note), a bad id from an LLM should be a loud error.
    if !path.exists() {
        return Err(ToolError::Failed(format!("note not found: {id}")));
    }
    fs::read_to_string(&path).map_err(|e| ToolError::Failed(e.to_string()))
}

fn tool_write_note(app: &AppHandle, args: &Value) -> Result<String, ToolError> {
    let id = arg_str(args, "id")?;
    let content = arg_str(args, "content")?;
    let path = crate::note_file(app, &id).map_err(ToolError::Failed)?;
    if !path.exists() {
        return Err(ToolError::Failed(format!(
            "note not found: {id} (use create_note for new notes)"
        )));
    }
    fs::write(&path, &content).map_err(|e| ToolError::Failed(e.to_string()))?;
    emit_notes_changed(app, &id, "write");
    Ok(format!("wrote note {id}"))
}

async fn tool_create_note(app: &AppHandle, args: &Value) -> Result<String, ToolError> {
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let summary = match content.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(first) => format!("Create a new note — “{}”", truncate(first, 80)),
        None => "Create a new empty note".to_string(),
    };
    require_approval(app, "create_note", summary)
        .await
        .map_err(ToolError::Failed)?;

    let dir = crate::notes_dir(app).map_err(ToolError::Failed)?;
    fs::create_dir_all(&dir).map_err(|e| ToolError::Failed(e.to_string()))?;
    let id = crate::new_id();
    fs::write(dir.join(format!("{id}.md")), &content)
        .map_err(|e| ToolError::Failed(e.to_string()))?;
    emit_notes_changed(app, &id, "create");
    Ok(json!({ "id": id }).to_string())
}

async fn tool_delete_note(app: &AppHandle, args: &Value) -> Result<String, ToolError> {
    let id = arg_str(args, "id")?;
    let path = crate::note_file(app, &id).map_err(ToolError::Failed)?;
    if !path.exists() {
        return Err(ToolError::Failed(format!("note not found: {id}")));
    }
    // Put the note's title in the prompt so the user knows what's being deleted.
    let content = fs::read_to_string(&path).unwrap_or_default();
    let (title, _) = crate::derive(&content);
    require_approval(app, "delete_note", format!("Delete note “{}”", truncate(&title, 80)))
        .await
        .map_err(ToolError::Failed)?;

    fs::remove_file(&path).map_err(|e| ToolError::Failed(e.to_string()))?;
    emit_notes_changed(app, &id, "delete");
    Ok(format!("deleted note {id}"))
}

/// Emitted only from MCP mutation paths — the frontend's own writes go through
/// the tauri commands and must not echo back into it.
fn emit_notes_changed(app: &AppHandle, id: &str, kind: &str) {
    let _ = app.emit("notes-changed", json!({ "id": id, "kind": kind }));
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

// ---- approval -------------------------------------------------------------

async fn require_approval(app: &AppHandle, tool: &str, summary: String) -> Result<(), String> {
    let state = app.state::<McpState>();
    let (id, rx) = {
        let mut inner = state.0.lock().unwrap();
        if inner.session_allow.contains(tool) {
            return Ok(());
        }
        let id = inner.next_approval_id;
        inner.next_approval_id += 1;
        let (tx, rx) = oneshot::channel();
        inner.approvals.insert(
            id,
            PendingApproval {
                tool: tool.to_string(),
                tx,
            },
        );
        (id, rx)
        // Guard drops here — never held across an await.
    };

    let _ = app.emit(
        "mcp-approval-request",
        json!({ "id": id, "tool": tool, "summary": summary }),
    );
    // Surface the prompt even if the note is hidden. The window is a
    // non-activating NSPanel, so this floats it over the MCP client's window
    // without stealing focus — the user keeps typing and clicks when ready.
    // Must hop to the main thread: panel.show() is AppKit, and calling it from
    // the tokio worker running this handler kills the app on the spot.
    #[cfg(desktop)]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::show_window(&handle));
    }

    match tokio::time::timeout(Duration::from_secs(APPROVAL_TIMEOUT_SECS), rx).await {
        Ok(Ok(true)) => Ok(()),
        // Explicit deny, or the sender was dropped (server stopped).
        Ok(_) => Err("the user denied this request".to_string()),
        Err(_) => {
            state.0.lock().unwrap().approvals.remove(&id);
            // Let the frontend dismiss the card the user never answered.
            let _ = app.emit("mcp-approval-resolved", json!({ "id": id }));
            Err("approval request timed out".to_string())
        }
    }
}
