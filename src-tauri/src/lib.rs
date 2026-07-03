use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const LEGACY_FILE: &str = "note.md";
const NOTES_DIR: &str = "notes";

#[derive(Serialize)]
struct NoteMeta {
    id: String,
    title: String,
    preview: String,
    /// Full text, lowercased — used only for client-side search matching.
    body: String,
    modified: u64,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(NOTES_DIR))
}

/// Resolve `notes/{id}.md`, rejecting anything that isn't a plain alphanumeric id
/// (ids are generated as digit strings, so this also blocks path traversal).
fn note_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid note id".into());
    }
    Ok(notes_dir(app)?.join(format!("{id}.md")))
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    nanos.to_string()
}

fn modified_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// First non-empty line becomes the title (Markdown heading marks stripped);
/// the following text becomes a short preview.
fn derive(content: &str) -> (String, String) {
    let mut lines = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty());

    let title = lines
        .next()
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
        .to_string();
    let title = if title.is_empty() {
        "Untitled note".to_string()
    } else {
        title
    };

    let preview: String = lines.collect::<Vec<_>>().join(" ");
    let preview: String = preview.chars().take(140).collect();
    (title, preview)
}

/// One-time move of the old single `note.md` into `notes/` so upgrades keep data.
fn migrate_legacy(app: &AppHandle) -> Result<(), String> {
    let legacy = app_dir(app)?.join(LEGACY_FILE);
    if !legacy.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&legacy).unwrap_or_default();
    let dir = notes_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !content.trim().is_empty() {
        let path = dir.join(format!("{}.md", new_id()));
        fs::write(&path, &content).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_file(&legacy);
    Ok(())
}

#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<NoteMeta>, String> {
    migrate_legacy(&app)?;
    let dir = notes_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut notes = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        let (title, preview) = derive(&content);
        notes.push(NoteMeta {
            id,
            title,
            preview,
            body: content.to_lowercase(),
            modified: modified_millis(&path),
        });
    }
    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(notes)
}

#[tauri::command]
fn read_note(app: AppHandle, id: String) -> Result<String, String> {
    let path = note_file(&app, &id)?;
    Ok(fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
fn write_note(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let path = note_file(&app, &id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_note(app: AppHandle) -> Result<String, String> {
    let dir = notes_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = new_id();
    fs::write(dir.join(format!("{id}.md")), "").map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let path = note_file(&app, &id)?;
    let _ = fs::remove_file(path);
    Ok(())
}

/// Convert the main window into a non-activating floating panel so it can overlay
/// other apps' fullscreen Spaces (and appear on every Space) the way Raycast does.
#[cfg(target_os = "macos")]
// `set_collection_behaviour` takes cocoa's `NSWindowCollectionBehavior`, which the
// crate marks deprecated but still requires — scope the allow to this fn only.
#[allow(deprecated)]
fn make_panel(win: &tauri::WebviewWindow) {
    use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
    use tauri_nspanel::WebviewWindowExt;

    // NSWindowStyleMaskNonactivatingPanel — the panel takes key input without
    // activating the app, so showing it never pulls you out of a fullscreen app.
    const NONACTIVATING_PANEL: i32 = 1 << 7;
    // NSWindowStyleMaskResizable — without this bit macOS blocks drag-to-resize,
    // so the resize cursor shows but the window won't actually resize.
    const RESIZABLE: i32 = 1 << 3;
    // NSMainMenuWindowLevel (24) as a literal, avoiding the deprecated static.
    const NS_MAIN_MENU_WINDOW_LEVEL: i32 = 24;

    if let Ok(panel) = win.to_panel() {
        // Sit just above the menu bar so it's visible over fullscreen windows.
        panel.set_level(NS_MAIN_MENU_WINDOW_LEVEL + 1);
        panel.set_style_mask(NONACTIVATING_PANEL | RESIZABLE);
        panel.set_collection_behaviour(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary,
        );
    }
}

/// Bring the note to the front and focus it.
#[cfg(desktop)]
fn show_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.show();
            return;
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Show/hide the floating note. Hide only when it's already visible AND focused,
/// so the hotkey pulls the note to the front if it's behind another window.
#[cfg(desktop)]
fn toggle_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("main") {
            if panel.is_visible() {
                panel.order_out(None);
            } else {
                panel.show();
            }
            return;
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Menu bar (tray) icon: left-click toggles the note; the menu offers Show / Quit.
#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show Note", true, Some("Alt+."))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Cmd+Q"))?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("note-up")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{
            Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
        };
        use tauri_plugin_window_state::StateFlags;

        // Persist only window geometry — not visibility — so the note always
        // starts shown, wherever you last left it.
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION)
                .build(),
        );

        // ⌥. (Option+Period) — global show/hide toggle.
        let toggle = Shortcut::new(Some(Modifiers::ALT), Code::Period);

        builder = builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &toggle && event.state() == ShortcutState::Pressed {
                            toggle_window(app);
                        }
                    })
                    .build(),
            )
            .setup(move |app| {
                app.global_shortcut().register(toggle)?;

                // Run as a background agent: no Dock icon, stays alive while hidden.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);

                // Summon the note onto whichever Space / monitor is active, not just
                // the desktop it was first opened on (Raycast-style).
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_visible_on_all_workspaces(true);

                    // A regular window activates the app when shown, which yanks macOS out
                    // of another app's fullscreen Space instead of overlaying it. Turning the
                    // window into a *non-activating NSPanel* (like Raycast/Spotlight) lets it
                    // float over fullscreen apps without stealing focus or switching Spaces.
                    #[cfg(target_os = "macos")]
                    make_panel(&win);
                }

                setup_tray(app.handle())?;
                Ok(())
            });
    }

    builder
        .invoke_handler(tauri::generate_handler![
            list_notes,
            read_note,
            write_note,
            create_note,
            delete_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
