#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const STATE_DIR_NAME: &str = "editor-state";
const TEMP_DOCS_DIR_NAME: &str = "temp-docs";
const SESSION_FILE_NAME: &str = "session.json";
const APP_NAME: &str = "TinyMD";
const LEGACY_FALLBACK_APP_NAMES: &[&str] = &["TinyMd", "rust-milkdown"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorTabState {
    id: String,
    path: Option<String>,
    title: String,
    content: String,
    saved_content: String,
    dirty: bool,
    temporary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EditorSessionState {
    tabs: Vec<EditorTabState>,
    active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LoadedEditorSessionState {
    tabs: Vec<LoadedEditorTabState>,
    active_tab_id: Option<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadedEditorTabState {
    id: String,
    path: Option<String>,
    title: String,
    content: String,
    saved_content: String,
    dirty: bool,
    temporary: bool,
    loaded: bool,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

fn normalize(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| format!("无法读取文件 {path}: {err}"))
}

fn write_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|err| format!("无法保存文件 {path}: {err}"))
}

fn legacy_state_dir() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|err| format!("无法定位应用安装目录: {err}"))?;
    let parent = exe_path
        .parent()
        .ok_or_else(|| "无法定位应用安装目录".to_string())?;
    Ok(parent.join(STATE_DIR_NAME))
}

fn fallback_data_dir_with_name(app_name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let app_data = env::var_os("APPDATA")
            .ok_or_else(|| "无法读取 APPDATA 目录".to_string())?;
        return Ok(PathBuf::from(app_data).join(app_name));
    }

    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").ok_or_else(|| "无法读取 HOME 目录".to_string())?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(app_name));
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(xdg_data_home).join(app_name));
        }

        let home = env::var_os("HOME").ok_or_else(|| "无法读取 HOME 目录".to_string())?;
        Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join(app_name))
    }
}

fn fallback_data_dir() -> Result<PathBuf, String> {
    fallback_data_dir_with_name(APP_NAME)
}

fn resolve_state_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("无法定位应用数据目录: {err}"))
        .or_else(|_| fallback_data_dir())
}

fn migrate_state_root(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if !source_root.exists() || source_root == target_root {
        return Ok(());
    }

    fs::create_dir_all(target_root).map_err(|err| {
        format!(
            "无法创建应用数据目录 {}: {err}",
            target_root.display()
        )
    })?;

    let target_session = target_root.join(SESSION_FILE_NAME);
    if !target_session.exists() {
        let legacy_session = source_root.join(SESSION_FILE_NAME);
        if legacy_session.exists() {
            fs::copy(&legacy_session, &target_session).map_err(|err| {
                format!(
                    "无法迁移编辑状态 {} -> {}: {err}",
                    legacy_session.display(),
                    target_session.display()
                )
            })?;
        }
    }

    let legacy_temp_docs = source_root.join(TEMP_DOCS_DIR_NAME);
    if legacy_temp_docs.exists() {
        let target_temp_docs = target_root.join(TEMP_DOCS_DIR_NAME);
        fs::create_dir_all(&target_temp_docs).map_err(|err| {
            format!(
                "无法创建临时文档目录 {}: {err}",
                target_temp_docs.display()
            )
        })?;

        let entries = fs::read_dir(&legacy_temp_docs).map_err(|err| {
            format!(
                "无法遍历旧临时文档目录 {}: {err}",
                legacy_temp_docs.display()
            )
        })?;

        for entry in entries {
            let entry = entry.map_err(|err| format!("无法读取旧临时文档目录项: {err}"))?;
            let from = entry.path();
            if !from.is_file() {
                continue;
            }

            let to = target_temp_docs.join(entry.file_name());
            if !to.exists() {
                fs::copy(&from, &to).map_err(|err| {
                    format!(
                        "无法迁移临时文档 {} -> {}: {err}",
                        from.display(),
                        to.display()
                    )
                })?;
            }
        }
    }

    Ok(())
}

fn migrate_legacy_state(target_root: &Path) -> Result<(), String> {
    let legacy_root = legacy_state_dir()?;
    migrate_state_root(&legacy_root, target_root)?;

    for legacy_name in LEGACY_FALLBACK_APP_NAMES {
        if let Ok(legacy_root) = fallback_data_dir_with_name(legacy_name) {
            migrate_state_root(&legacy_root, target_root)?;
        }
    }

    Ok(())
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = resolve_state_root(app)?;
    migrate_legacy_state(&path)?;
    fs::create_dir_all(&path)
        .map_err(|err| format!("无法创建状态目录 {}: {err}", path.display()))?;
    Ok(path)
}

fn temp_docs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = state_dir(app)?.join(TEMP_DOCS_DIR_NAME);
    fs::create_dir_all(&path)
        .map_err(|err| format!("无法创建临时文档目录 {}: {err}", path.display()))?;
    Ok(path)
}

fn session_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(SESSION_FILE_NAME))
}

fn temp_file_name(tab_id: &str) -> String {
    let mut sanitized = String::with_capacity(tab_id.len());
    for ch in tab_id.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            sanitized.push(ch);
        } else {
            sanitized.push('_');
        }
    }

    if sanitized.is_empty() {
        sanitized.push_str("untitled");
    }

    format!("{sanitized}.md")
}

fn recovered_tab_id(original_id: &str) -> String {
    format!("recovered:{original_id}")
}

fn recovered_tab_title(path: Option<&str>, fallback_title: &str) -> String {
    let base_title = path
        .and_then(|value| Path::new(value).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or(fallback_title);
    format!("{base_title}（已恢复）")
}

fn recover_file_tab(tab: &EditorTabState) -> EditorTabState {
    EditorTabState {
        id: recovered_tab_id(&tab.id),
        path: None,
        title: recovered_tab_title(tab.path.as_deref(), &tab.title),
        content: tab.content.clone(),
        saved_content: tab.saved_content.clone(),
        dirty: true,
        temporary: true,
    }
}

fn into_loaded_tab(tab: EditorTabState, loaded: bool) -> LoadedEditorTabState {
    LoadedEditorTabState {
        id: tab.id,
        path: tab.path,
        title: tab.title,
        content: tab.content,
        saved_content: tab.saved_content,
        dirty: tab.dirty,
        temporary: tab.temporary,
        loaded,
    }
}

fn sync_temp_docs(app: &AppHandle, session: &EditorSessionState) -> Result<(), String> {
    let temp_dir = temp_docs_dir(app)?;
    let mut active_files = HashSet::new();

    for tab in session.tabs.iter().filter(|tab| tab.temporary) {
        let file_name = temp_file_name(&tab.id);
        let file_path = temp_dir.join(&file_name);
        fs::write(&file_path, &tab.content)
            .map_err(|err| format!("无法保存临时文档 {}: {err}", file_path.display()))?;
        active_files.insert(file_name);
    }

    let entries = fs::read_dir(&temp_dir)
        .map_err(|err| format!("无法遍历临时文档目录 {}: {err}", temp_dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("无法读取临时文档目录项: {err}"))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !active_files.contains(&file_name) {
            let path = entry.path();
            if path.is_file() {
                fs::remove_file(&path)
                    .map_err(|err| format!("无法删除旧临时文档 {}: {err}", path.display()))?;
            }
        }
    }

    Ok(())
}

fn read_temp_doc_content(app: &AppHandle, tab_id: &str) -> Result<Option<String>, String> {
    let path = temp_docs_dir(app)?.join(temp_file_name(tab_id));
    if !path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&path)
        .map(Some)
        .map_err(|err| format!("无法读取临时文档 {}: {err}", path.display()))
}

fn validate_external_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("mailto:")
    {
        Ok(trimmed)
    } else {
        Err(format!("不支持打开该链接: {trimmed}"))
    }
}

#[cfg(target_os = "windows")]
fn launch_external_url(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开链接 {url}: {err}"))
}

#[cfg(target_os = "macos")]
fn launch_external_url(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开链接 {url}: {err}"))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn launch_external_url(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开链接 {url}: {err}"))
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<String, String> {
    if !is_markdown(Path::new(&path)) {
        return Err(format!("仅支持 Markdown 文件: {path}"));
    }

    read_file(&path)
}

#[tauri::command]
fn get_launch_markdown_files() -> Vec<String> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();

    for arg in env::args_os().skip(1) {
        let path = PathBuf::from(arg);
        if !path.is_file() || !is_markdown(&path) {
            continue;
        }

        let normalized = normalize(path);
        if seen.insert(normalized.clone()) {
            files.push(normalized);
        }
    }

    files
}

#[tauri::command]
fn save_markdown_file(path: String, content: String) -> Result<(), String> {
    write_file(&path, &content)
}

#[tauri::command]
fn load_editor_session(app: AppHandle) -> Result<LoadedEditorSessionState, String> {
    let session_path = session_file_path(&app)?;
    if !session_path.exists() {
        return Ok(LoadedEditorSessionState::default());
    }

    let raw = fs::read_to_string(&session_path)
        .map_err(|err| format!("无法读取编辑状态 {}: {err}", session_path.display()))?;
    let session: EditorSessionState = serde_json::from_str(&raw)
        .map_err(|err| format!("无法解析编辑状态 {}: {err}", session_path.display()))?;
    let mut warnings = Vec::new();
    let mut restored_tabs = Vec::with_capacity(session.tabs.len());
    let mut seen_paths = HashSet::new();
    let requested_active_id = session.active_tab_id.clone();
    let mut restored_active_id = None;

    for mut tab in session.tabs {
        let original_id = tab.id.clone();
        let is_requested_active = requested_active_id.as_deref() == Some(original_id.as_str());

        if tab.temporary {
            if let Some(content) = read_temp_doc_content(&app, &tab.id)? {
                tab.content = content;
            }

            if is_requested_active {
                restored_active_id = Some(tab.id.clone());
            }

            restored_tabs.push(into_loaded_tab(tab, true));
            continue;
        }

        let Some(path) = tab.path.clone() else {
            let recovered = recover_file_tab(&tab);
            warnings.push(format!(
                "已恢复 {}，原文件路径缺失，请重新保存。",
                recovered.title
            ));
            if is_requested_active {
                restored_active_id = Some(recovered.id.clone());
            }
            restored_tabs.push(into_loaded_tab(recovered, true));
            continue;
        };

        let normalized_path = normalize(PathBuf::from(&path));
        if !seen_paths.insert(normalized_path.clone()) {
            warnings.push(format!(
                "启动时跳过重复文件标签：{}",
                Path::new(&normalized_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&normalized_path)
            ));
            continue;
        }

        let path_ref = Path::new(&normalized_path);
        if !path_ref.exists() {
            let mut recovered = recover_file_tab(&tab);
            recovered.title = recovered_tab_title(Some(&normalized_path), &tab.title);
            warnings.push(format!(
                "文件不存在，已将 {} 恢复为临时文档。",
                recovered.title
            ));
            if is_requested_active {
                restored_active_id = Some(recovered.id.clone());
            }
            restored_tabs.push(into_loaded_tab(recovered, true));
            continue;
        }

        if !path_ref.is_file() || !is_markdown(path_ref) {
            let mut recovered = recover_file_tab(&tab);
            recovered.title = recovered_tab_title(Some(&normalized_path), &tab.title);
            warnings.push(format!(
                "文件不可用，已将 {} 恢复为临时文档。",
                recovered.title
            ));
            if is_requested_active {
                restored_active_id = Some(recovered.id.clone());
            }
            restored_tabs.push(into_loaded_tab(recovered, true));
            continue;
        }

        let title = path_ref
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
            .unwrap_or_else(|| tab.title.clone());

        tab.id = normalized_path.clone();
        tab.path = Some(normalized_path.clone());
        tab.title = title;

        if tab.dirty {
            if is_requested_active {
                match fs::read_to_string(path_ref) {
                    Ok(content) => {
                        tab.saved_content = content;
                        tab.dirty = tab.content != tab.saved_content;
                    }
                    Err(_) => {
                        let mut recovered = recover_file_tab(&tab);
                        recovered.title = recovered_tab_title(Some(&normalized_path), &tab.title);
                        warnings.push(format!(
                            "无法读取文件，已将 {} 恢复为临时文档。",
                            recovered.title
                        ));
                        restored_active_id = Some(recovered.id.clone());
                        restored_tabs.push(into_loaded_tab(recovered, true));
                        continue;
                    }
                }
            }

            if is_requested_active {
                restored_active_id = Some(tab.id.clone());
            }
            restored_tabs.push(into_loaded_tab(tab, true));
            continue;
        }

        if !is_requested_active {
            tab.content.clear();
            tab.saved_content.clear();
            restored_tabs.push(into_loaded_tab(tab, false));
            continue;
        }

        match fs::read_to_string(path_ref) {
            Ok(content) => {
                tab.content = content.clone();
                tab.saved_content = content;
                tab.dirty = false;
                restored_active_id = Some(tab.id.clone());
                restored_tabs.push(into_loaded_tab(tab, true));
            }
            Err(_) => {
                let mut recovered = recover_file_tab(&tab);
                recovered.title = recovered_tab_title(Some(&normalized_path), &tab.title);
                warnings.push(format!(
                    "无法读取文件，已将 {} 恢复为临时文档。",
                    recovered.title
                ));
                restored_active_id = Some(recovered.id.clone());
                restored_tabs.push(into_loaded_tab(recovered, true));
            }
        }
    }

    let active_tab_id = restored_active_id
        .filter(|id| restored_tabs.iter().any(|tab| tab.id == *id))
        .or_else(|| restored_tabs.last().map(|tab| tab.id.clone()));

    Ok(LoadedEditorSessionState {
        tabs: restored_tabs,
        active_tab_id,
        warnings,
    })
}

#[tauri::command]
fn save_editor_session(app: AppHandle, session: EditorSessionState) -> Result<(), String> {
    sync_temp_docs(&app, &session)?;

    let session_path = session_file_path(&app)?;
    let mut persisted_session = session;
    for tab in &mut persisted_session.tabs {
        if !tab.temporary && !tab.dirty {
            tab.content.clear();
            tab.saved_content.clear();
        }
    }

    let serialized = serde_json::to_string_pretty(&persisted_session)
        .map_err(|err| format!("无法序列化编辑状态: {err}"))?;
    fs::write(&session_path, serialized)
        .map_err(|err| format!("无法写入编辑状态 {}: {err}", session_path.display()))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let safe_url = validate_external_url(&url)?;
    launch_external_url(safe_url)
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &Path) -> Result<(), String> {
    if path.exists() {
        Command::new("explorer")
            .args(["/select,", &path.to_string_lossy()])
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("无法打开目录 {}: {err}", path.display()))
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| format!("找不到目录: {}", path.display()))?;
        Command::new("explorer")
            .arg(parent)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("无法打开目录 {}: {err}", parent.display()))
    }
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开目录 {}: {err}", path.display()))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn reveal_path(path: &Path) -> Result<(), String> {
    let target = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .ok_or_else(|| format!("找不到目录: {}", path.display()))?
            .to_path_buf()
    };

    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开目录 {}: {err}", path.display()))
}

#[tauri::command]
fn open_file_location(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    reveal_path(&target)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_launch_markdown_files,
            read_markdown_file,
            save_markdown_file,
            load_editor_session,
            save_editor_session,
            open_external_url,
            open_file_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
