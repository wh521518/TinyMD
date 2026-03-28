#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, DragDropEvent, Emitter, Manager, State, WebviewEvent, WindowEvent,
};

const STATE_DIR_NAME: &str = "editor-state";
const TEMP_DOCS_DIR_NAME: &str = "temp-docs";
const SESSION_FILE_NAME: &str = "session.json";
const APP_NAME: &str = "TinyMD";
const LEGACY_FALLBACK_APP_NAMES: &[&str] = &["TinyMd", "rust-milkdown"];
const DEFAULT_IMAGE_DIR: &str = "_assets";
const TRAY_ID: &str = "main-tray";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_REQUEST_EXIT_EVENT: &str = "tray-request-exit";
const APP_CLOSE_INTENT_EVENT: &str = "app-close-intent";
const OPEN_REQUESTED_MARKDOWN_FILES_EVENT: &str = "open-requested-markdown-files";
const ASSET_IMPORT_STATUS_EVENT: &str = "asset-import-status";
const OPEN_DROPPED_MARKDOWN_FILES_EVENT: &str = "open-dropped-markdown-files";
const INSERT_DROPPED_ASSET_PATHS_EVENT: &str = "insert-dropped-asset-paths";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DropPositionPayload {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedAssetPathsPayload {
    paths: Vec<String>,
    position: DropPositionPayload,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
enum TabStorageKind {
    #[default]
    Saved,
    Draft,
    TemporaryFile,
    Recovered,
}

impl TabStorageKind {
    fn uses_temporary_document_storage(self) -> bool {
        !matches!(self, Self::Saved)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorTabState {
    id: String,
    path: Option<String>,
    source_path: Option<String>,
    title: String,
    content: String,
    saved_content: String,
    dirty: bool,
    storage_kind: TabStorageKind,
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
    source_path: Option<String>,
    title: String,
    content: String,
    saved_content: String,
    dirty: bool,
    storage_kind: TabStorageKind,
    loaded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEditorTabState {
    id: String,
    path: Option<String>,
    source_path: Option<String>,
    title: String,
    content: String,
    saved_content: String,
    dirty: bool,
    storage_kind: Option<TabStorageKind>,
    temporary: Option<bool>,
}

fn infer_storage_kind(
    id: &str,
    storage_kind: Option<TabStorageKind>,
    temporary: Option<bool>,
) -> TabStorageKind {
    if let Some(storage_kind) = storage_kind {
        return storage_kind;
    }

    match temporary {
        Some(false) => TabStorageKind::Saved,
        Some(true) | None if id.starts_with("recovered:") => TabStorageKind::Recovered,
        Some(true) | None if id.starts_with("temp:drop:") => TabStorageKind::TemporaryFile,
        Some(true) | None => TabStorageKind::Draft,
    }
}

fn infer_source_path(
    path: &Option<String>,
    source_path: Option<String>,
    storage_kind: TabStorageKind,
) -> Option<String> {
    if source_path.is_some() {
        return source_path;
    }

    if matches!(storage_kind, TabStorageKind::Saved) {
        return path.clone();
    }

    None
}

impl<'de> Deserialize<'de> for EditorTabState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawEditorTabState::deserialize(deserializer)?;
        let storage_kind = infer_storage_kind(&raw.id, raw.storage_kind, raw.temporary);
        let path = raw.path;
        let source_path = infer_source_path(&path, raw.source_path, storage_kind);
        Ok(Self {
            id: raw.id.clone(),
            path,
            source_path,
            title: raw.title,
            content: raw.content,
            saved_content: raw.saved_content,
            dirty: raw.dirty,
            storage_kind,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAssetMetadata {
    file_name: String,
    size_bytes: u64,
    modified_unix_ms: Option<u64>,
    extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetDirectoryStatus {
    path: String,
    exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetImportStatusPayload {
    document_path: String,
    relative_path: String,
    file_name: String,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetUploadSession {
    upload_id: String,
    relative_path: String,
    file_name: String,
}

#[derive(Debug, Clone)]
struct PendingAssetUpload {
    document_path: String,
    relative_path: String,
    file_name: String,
    temp_path: PathBuf,
    target_path: PathBuf,
}

#[derive(Default)]
struct AppLifecycleState {
    allow_exit: AtomicBool,
    pending_asset_imports: Mutex<HashSet<PathBuf>>,
    pending_asset_uploads: Mutex<HashMap<String, PendingAssetUpload>>,
    next_upload_id: AtomicU64,
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

fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn collect_markdown_files<I, S>(args: I, cwd: Option<&Path>) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    let mut files = Vec::new();
    let mut seen = HashSet::new();

    for arg in args {
        let mut path = PathBuf::from(arg.into());
        if path.is_relative() {
            if let Some(base_dir) = cwd {
                path = base_dir.join(path);
            }
        }

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

fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| format!("无法读取文件 {path}: {err}"))
}

fn write_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|err| format!("无法保存文件 {path}: {err}"))
}

fn is_supported_image_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif"
    )
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn sanitize_image_dir(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim().replace('\\', "/");
    let candidate = if trimmed.is_empty() {
        DEFAULT_IMAGE_DIR
    } else {
        trimmed.as_str()
    };

    let mut sanitized = PathBuf::new();
    for component in Path::new(candidate).components() {
        match component {
            std::path::Component::Normal(value) => sanitized.push(value),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("图片目录必须是相对路径，且不能包含 ..".to_string());
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        sanitized.push(DEFAULT_IMAGE_DIR);
    }

    Ok(sanitized)
}

fn sanitize_asset_stem(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    for ch in value.trim().chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
            sanitized.push('-');
        } else {
            sanitized.push(ch);
        }
    }

    let trimmed = sanitized.trim_matches(|ch: char| ch.is_whitespace() || ch == '.');
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_asset_extension(value: &str) -> Option<String> {
    let sanitized = value
        .trim()
        .trim_matches('.')
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>();

    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized.to_ascii_lowercase())
    }
}

fn build_unique_asset_path(
    target_dir: &Path,
    file_name: Option<&str>,
    default_name: &str,
    reserved_paths: Option<&HashSet<PathBuf>>,
) -> PathBuf {
    let preferred_name = file_name.unwrap_or(default_name);
    let preferred_path = Path::new(preferred_name);
    let stem = preferred_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_asset_stem)
        .unwrap_or_else(|| "attachment".to_string());
    let extension = preferred_path
        .extension()
        .and_then(|value| value.to_str())
        .and_then(sanitize_asset_extension);

    let mut index = 0usize;
    loop {
        let file_name = match extension.as_deref() {
            Some(extension) if index == 0 => format!("{stem}.{extension}"),
            Some(extension) => format!("{stem}-{index}.{extension}"),
            None if index == 0 => stem.clone(),
            None => format!("{stem}-{index}"),
        };
        let candidate = target_dir.join(file_name);
        if !candidate.exists()
            && reserved_paths
                .map(|paths| !paths.contains(&candidate))
                .unwrap_or(true)
        {
            return candidate;
        }
        index += 1;
    }
}

fn resolve_asset_directory_path(
    document_path: &str,
    assets_dir: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let document = PathBuf::from(document_path);
    if !is_markdown(&document) {
        return Err(format!("仅支持为 Markdown 文档保存附件: {document_path}"));
    }

    let document_dir = document
        .parent()
        .ok_or_else(|| format!("无法定位文档目录: {}", document.display()))?
        .to_path_buf();
    let relative_dir = sanitize_image_dir(assets_dir)?;
    let target_dir = document_dir.join(relative_dir);
    Ok((document_dir, target_dir))
}

fn resolve_asset_target_path(
    document_path: &str,
    assets_dir: &str,
    file_name: Option<&str>,
    default_name: &str,
    reserved_paths: Option<&HashSet<PathBuf>>,
) -> Result<(PathBuf, PathBuf), String> {
    let (document_dir, target_dir) = resolve_asset_directory_path(document_path, assets_dir)?;
    fs::create_dir_all(&target_dir)
        .map_err(|err| format!("无法创建资源目录 {}: {err}", target_dir.display()))?;

    let target_path = build_unique_asset_path(&target_dir, file_name, default_name, reserved_paths);
    Ok((document_dir, target_path))
}

fn legacy_state_dir() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|err| format!("无法定位应用安装目录: {err}"))?;
    let parent = exe_path
        .parent()
        .ok_or_else(|| "无法定位应用安装目录".to_string())?;
    Ok(parent.join(STATE_DIR_NAME))
}

fn fallback_data_dir_with_name(app_name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let app_data = env::var_os("APPDATA").ok_or_else(|| "无法读取 APPDATA 目录".to_string())?;
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

    fs::create_dir_all(target_root)
        .map_err(|err| format!("无法创建应用数据目录 {}: {err}", target_root.display()))?;

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
        fs::create_dir_all(&target_temp_docs)
            .map_err(|err| format!("无法创建临时文档目录 {}: {err}", target_temp_docs.display()))?;

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

fn append_drag_debug_log(app: &AppHandle, label: &str, detail: &str) {
    let Ok(log_path) = state_dir(app).map(|dir| dir.join("drag-debug.log")) else {
        return;
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string());

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{timestamp}] {label}: {detail}");
    }
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

fn temp_doc_slug(tab_id: &str) -> String {
    temp_file_name(tab_id)
        .strip_suffix(".md")
        .unwrap_or("untitled")
        .to_string()
}

fn legacy_temp_doc_path(app: &AppHandle, tab_id: &str) -> Result<PathBuf, String> {
    Ok(temp_docs_dir(app)?.join(temp_file_name(tab_id)))
}

fn temp_doc_dir_path(app: &AppHandle, tab_id: &str) -> Result<PathBuf, String> {
    Ok(temp_docs_dir(app)?.join(temp_doc_slug(tab_id)))
}

fn temp_doc_path(app: &AppHandle, tab_id: &str) -> Result<PathBuf, String> {
    Ok(temp_doc_dir_path(app, tab_id)?.join("document.md"))
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
        source_path: None,
        title: recovered_tab_title(
            tab.source_path.as_deref().or(tab.path.as_deref()),
            &tab.title,
        ),
        content: tab.content.clone(),
        saved_content: tab.saved_content.clone(),
        dirty: true,
        storage_kind: TabStorageKind::Recovered,
    }
}

fn into_loaded_tab(tab: EditorTabState, loaded: bool) -> LoadedEditorTabState {
    LoadedEditorTabState {
        id: tab.id,
        path: tab.path,
        source_path: tab.source_path,
        title: tab.title,
        content: tab.content,
        saved_content: tab.saved_content,
        dirty: tab.dirty,
        storage_kind: tab.storage_kind,
        loaded,
    }
}

fn assign_temp_doc_path(app: &AppHandle, tab: &mut EditorTabState) -> Result<(), String> {
    tab.path = Some(normalize(temp_doc_path(app, &tab.id)?));
    Ok(())
}

fn replace_asset_reference(content: String, old_path: &str, new_path: &str) -> String {
    content
        .replace(&format!("({old_path})"), &format!("({new_path})"))
        .replace(&format!("(<{old_path}>)"), &format!("(<{new_path}>)"))
        .replace(&format!("\"{old_path}\""), &format!("\"{new_path}\""))
        .replace(&format!("'{old_path}'"), &format!("'{new_path}'"))
}

fn copy_temp_assets_and_rewrite(
    temp_doc_dir: &Path,
    temp_doc_path: &Path,
    target_doc_path: &Path,
    content: &str,
) -> Result<String, String> {
    if !temp_doc_dir.exists() {
        return Ok(content.to_string());
    }

    let target_doc_dir = target_doc_path
        .parent()
        .ok_or_else(|| format!("无法定位文档目录: {}", target_doc_path.display()))?;
    fs::create_dir_all(target_doc_dir)
        .map_err(|err| format!("无法创建文档目录 {}: {err}", target_doc_dir.display()))?;

    let mut rewritten = content.to_string();
    let mut pending = vec![temp_doc_dir.to_path_buf()];

    while let Some(current_dir) = pending.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|err| format!("无法遍历临时资源目录 {}: {err}", current_dir.display()))?;

        for entry in entries {
            let entry = entry.map_err(|err| format!("无法读取临时资源目录项: {err}"))?;
            let source_path = entry.path();

            if source_path == temp_doc_path {
                continue;
            }

            if source_path.is_dir() {
                pending.push(source_path);
                continue;
            }

            if !source_path.is_file() {
                continue;
            }

            let relative_source = source_path.strip_prefix(temp_doc_dir).map_err(|err| {
                format!("无法计算临时资源相对路径 {}: {err}", source_path.display())
            })?;
            let destination_path = target_doc_dir.join(relative_source);
            let destination_dir = destination_path
                .parent()
                .ok_or_else(|| format!("无法定位目标资源目录: {}", destination_path.display()))?;
            fs::create_dir_all(destination_dir).map_err(|err| {
                format!("无法创建目标资源目录 {}: {err}", destination_dir.display())
            })?;

            let final_destination = if destination_path.exists() {
                build_unique_asset_path(
                    destination_dir,
                    destination_path
                        .file_name()
                        .and_then(|value| value.to_str()),
                    "attachment",
                    None,
                )
            } else {
                destination_path
            };

            fs::copy(&source_path, &final_destination).map_err(|err| {
                format!(
                    "无法迁移临时资源 {} -> {}: {err}",
                    source_path.display(),
                    final_destination.display()
                )
            })?;

            let old_relative = relative_source.to_string_lossy().replace('\\', "/");
            let new_relative = final_destination
                .strip_prefix(target_doc_dir)
                .map_err(|err| {
                    format!(
                        "无法计算目标资源相对路径 {}: {err}",
                        final_destination.display()
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");

            if old_relative != new_relative {
                rewritten = replace_asset_reference(rewritten, &old_relative, &new_relative);
            }
        }
    }

    Ok(rewritten)
}

fn sync_temp_docs(app: &AppHandle, session: &EditorSessionState) -> Result<(), String> {
    let temp_dir = temp_docs_dir(app)?;
    let mut active_dirs = HashSet::new();

    for tab in session
        .tabs
        .iter()
        .filter(|tab| tab.storage_kind.uses_temporary_document_storage())
    {
        let tab_dir = temp_doc_dir_path(app, &tab.id)?;
        let file_path = tab_dir.join("document.md");
        fs::create_dir_all(&tab_dir)
            .map_err(|err| format!("无法创建临时文档目录 {}: {err}", tab_dir.display()))?;
        fs::write(&file_path, &tab.content)
            .map_err(|err| format!("无法保存临时文档 {}: {err}", file_path.display()))?;
        active_dirs.insert(
            tab_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
        );
    }

    let entries = fs::read_dir(&temp_dir)
        .map_err(|err| format!("无法遍历临时文档目录 {}: {err}", temp_dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("无法读取临时文档目录项: {err}"))?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !active_dirs.contains(&file_name) {
                fs::remove_dir_all(&path)
                    .map_err(|err| format!("无法删除旧临时文档目录 {}: {err}", path.display()))?;
            }
            continue;
        }

        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|err| format!("无法删除旧临时文档 {}: {err}", path.display()))?;
        }
    }

    Ok(())
}

fn read_temp_doc_content(app: &AppHandle, tab_id: &str) -> Result<Option<String>, String> {
    let path = temp_doc_path(app, tab_id)?;
    if path.exists() {
        return fs::read_to_string(&path)
            .map(Some)
            .map_err(|err| format!("无法读取临时文档 {}: {err}", path.display()));
    }

    let legacy_path = legacy_temp_doc_path(app, tab_id)?;
    if !legacy_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&legacy_path)
        .map(Some)
        .map_err(|err| format!("无法读取临时文档 {}: {err}", legacy_path.display()))
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
    let cwd = env::current_dir().ok();
    collect_markdown_files(env::args_os().skip(1), cwd.as_deref())
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

        if tab.storage_kind.uses_temporary_document_storage() {
            if let Some(content) = read_temp_doc_content(&app, &tab.id)? {
                tab.content = content;
            }
            assign_temp_doc_path(&app, &mut tab)?;

            if is_requested_active {
                restored_active_id = Some(tab.id.clone());
            }

            restored_tabs.push(into_loaded_tab(tab, true));
            continue;
        }

        let Some(path) = tab.source_path.clone() else {
            let mut recovered = recover_file_tab(&tab);
            assign_temp_doc_path(&app, &mut recovered)?;
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
            assign_temp_doc_path(&app, &mut recovered)?;
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
            assign_temp_doc_path(&app, &mut recovered)?;
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
        tab.source_path = Some(normalized_path.clone());
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
                        assign_temp_doc_path(&app, &mut recovered)?;
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
                assign_temp_doc_path(&app, &mut recovered)?;
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
        if !tab.storage_kind.uses_temporary_document_storage() && !tab.dirty {
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
    let to_windows_string = |value: PathBuf| value.to_string_lossy().replace('/', "\\");

    if path.exists() {
        let target = fs::canonicalize(path)
            .map_err(|err| format!("无法解析路径 {}: {err}", path.display()))?;

        if target.is_dir() {
            return Command::new("explorer.exe")
                .arg(to_windows_string(target.clone()))
                .spawn()
                .map(|_| ())
                .map_err(|err| format!("无法打开目录 {}: {err}", target.display()));
        }

        let select_arg = format!("/select,{}", to_windows_string(target.clone()));
        return Command::new("explorer.exe")
            .arg(select_arg)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("无法打开目录 {}: {err}", target.display()));
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("找不到目录: {}", path.display()))?;
    let target_dir = fs::canonicalize(parent)
        .map_err(|err| format!("无法解析目录 {}: {err}", parent.display()))?;

    Command::new("explorer.exe")
        .arg(to_windows_string(target_dir.clone()))
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开目录 {}: {err}", target_dir.display()))
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

#[tauri::command]
fn read_image_data_url(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("图片文件不存在: {}", target.display()));
    }

    let mime_type = image_mime_type(&target)
        .ok_or_else(|| format!("不支持的图片格式: {}", target.display()))?;
    let bytes =
        fs::read(&target).map_err(|err| format!("无法读取图片文件 {}: {err}", target.display()))?;
    let encoded = BASE64_STANDARD.encode(bytes);
    Ok(format!("data:{mime_type};base64,{encoded}"))
}

#[tauri::command]
fn read_local_asset_metadata(path: String) -> Result<LocalAssetMetadata, String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("附件文件不存在: {}", target.display()));
    }

    let metadata = fs::metadata(&target)
        .map_err(|err| format!("无法读取附件信息 {}: {err}", target.display()))?;
    let modified_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Ok(LocalAssetMetadata {
        file_name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        size_bytes: metadata.len(),
        modified_unix_ms,
        extension: target
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase()),
    })
}

#[tauri::command]
fn get_asset_directory_status(
    document_path: String,
    assets_dir: String,
) -> Result<AssetDirectoryStatus, String> {
    let (_, target_dir) = resolve_asset_directory_path(&document_path, &assets_dir)?;
    Ok(AssetDirectoryStatus {
        path: target_dir.to_string_lossy().to_string(),
        exists: target_dir.is_dir(),
    })
}

#[tauri::command]
fn ensure_temporary_document_path(app: AppHandle, tab_id: String) -> Result<String, String> {
    let temp_path = temp_doc_path(&app, &tab_id)?;
    let parent = temp_path
        .parent()
        .ok_or_else(|| format!("无法定位临时文档目录: {}", temp_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("无法创建临时文档目录 {}: {err}", parent.display()))?;
    Ok(normalize(temp_path))
}

#[tauri::command]
fn save_temporary_markdown_file(
    app: AppHandle,
    tab_id: String,
    path: String,
    content: String,
) -> Result<String, String> {
    let target_path = PathBuf::from(&path);
    if !is_markdown(&target_path) {
        return Err(format!("仅支持 Markdown 文件: {path}"));
    }

    let temp_path = temp_doc_path(&app, &tab_id)?;
    let temp_dir = temp_path
        .parent()
        .ok_or_else(|| format!("无法定位临时文档目录: {}", temp_path.display()))?;
    let rewritten = copy_temp_assets_and_rewrite(temp_dir, &temp_path, &target_path, &content)?;
    write_file(&path, &rewritten)?;

    if temp_dir.exists() {
        fs::remove_dir_all(temp_dir)
            .map_err(|err| format!("无法清理临时文档目录 {}: {err}", temp_dir.display()))?;
    }

    let legacy_path = legacy_temp_doc_path(&app, &tab_id)?;
    if legacy_path.exists() {
        fs::remove_file(&legacy_path)
            .map_err(|err| format!("无法清理旧临时文档 {}: {err}", legacy_path.display()))?;
    }

    Ok(rewritten)
}

#[tauri::command]
fn delete_temporary_document(app: AppHandle, tab_id: String) -> Result<(), String> {
    let temp_path = temp_doc_path(&app, &tab_id)?;
    let temp_dir = temp_path
        .parent()
        .ok_or_else(|| format!("无法定位临时文档目录: {}", temp_path.display()))?;

    if temp_dir.exists() {
        fs::remove_dir_all(temp_dir)
            .map_err(|err| format!("无法清理临时文档目录 {}: {err}", temp_dir.display()))?;
    }

    let legacy_path = legacy_temp_doc_path(&app, &tab_id)?;
    if legacy_path.exists() {
        fs::remove_file(&legacy_path)
            .map_err(|err| format!("无法清理旧临时文档 {}: {err}", legacy_path.display()))?;
    }

    Ok(())
}

#[tauri::command]
fn save_asset(
    document_path: String,
    assets_dir: String,
    file_name: Option<String>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let default_name = if file_name
        .as_deref()
        .map(|name| {
            Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| is_supported_image_extension(value))
                .is_some()
        })
        .unwrap_or(false)
    {
        "image.png"
    } else {
        "attachment.bin"
    };

    let (document_dir, target_path) = resolve_asset_target_path(
        &document_path,
        &assets_dir,
        file_name.as_deref(),
        default_name,
        None,
    )?;
    fs::write(&target_path, bytes)
        .map_err(|err| format!("无法写入附件文件 {}: {err}", target_path.display()))?;

    let relative_path = target_path
        .strip_prefix(&document_dir)
        .map_err(|err| format!("无法计算附件相对路径 {}: {err}", target_path.display()))?;

    Ok(relative_path.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn save_asset_from_path(
    document_path: String,
    assets_dir: String,
    source_path: String,
    file_name: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("附件源文件不存在: {}", source.display()));
    }

    let default_name = if file_name
        .as_deref()
        .or_else(|| source.file_name().and_then(|value| value.to_str()))
        .map(|name| {
            Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| is_supported_image_extension(value))
                .is_some()
        })
        .unwrap_or(false)
    {
        "image.png"
    } else {
        "attachment.bin"
    };

    let effective_file_name = file_name
        .as_deref()
        .or_else(|| source.file_name().and_then(|value| value.to_str()));
    let (document_dir, target_path) = resolve_asset_target_path(
        &document_path,
        &assets_dir,
        effective_file_name,
        default_name,
        None,
    )?;

    fs::copy(&source, &target_path).map_err(|err| {
        format!(
            "无法复制附件文件 {} -> {}: {err}",
            source.display(),
            target_path.display()
        )
    })?;

    let relative_path = target_path
        .strip_prefix(&document_dir)
        .map_err(|err| format!("无法计算附件相对路径 {}: {err}", target_path.display()))?;

    Ok(relative_path.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn begin_asset_upload(
    lifecycle: State<AppLifecycleState>,
    document_path: String,
    assets_dir: String,
    file_name: Option<String>,
) -> Result<AssetUploadSession, String> {
    let default_name = if file_name
        .as_deref()
        .map(|name| {
            Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| is_supported_image_extension(value))
                .is_some()
        })
        .unwrap_or(false)
    {
        "image.png"
    } else {
        "attachment.bin"
    };

    let upload_id = format!(
        "upload-{}",
        lifecycle.next_upload_id.fetch_add(1, Ordering::Relaxed)
    );

    let (target_path, relative_path, display_name, temp_path) = {
        let mut reserved = lifecycle
            .pending_asset_imports
            .lock()
            .map_err(|_| "无法锁定附件导入状态".to_string())?;
        let (document_dir, target_path) = resolve_asset_target_path(
            &document_path,
            &assets_dir,
            file_name.as_deref(),
            default_name,
            Some(&reserved),
        )?;
        reserved.insert(target_path.clone());

        let relative_path = target_path
            .strip_prefix(&document_dir)
            .map_err(|err| format!("无法计算附件相对路径 {}: {err}", target_path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        let display_name = file_name.clone().unwrap_or_else(|| {
            target_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| "attachment".to_string())
        });
        let temp_path = target_path.with_file_name(format!(".{upload_id}.part"));
        (target_path, relative_path, display_name, temp_path)
    };

    if temp_path.exists() {
        fs::remove_file(&temp_path)
            .map_err(|err| format!("无法清理临时上传文件 {}: {err}", temp_path.display()))?;
    }

    lifecycle
        .pending_asset_uploads
        .lock()
        .map_err(|_| "无法锁定附件上传状态".to_string())?
        .insert(
            upload_id.clone(),
            PendingAssetUpload {
                document_path,
                relative_path: relative_path.clone(),
                file_name: display_name.clone(),
                temp_path,
                target_path,
            },
        );

    Ok(AssetUploadSession {
        upload_id,
        relative_path,
        file_name: display_name,
    })
}

#[tauri::command]
fn append_asset_upload_chunk(
    lifecycle: State<AppLifecycleState>,
    upload_id: String,
    base64_chunk: String,
) -> Result<(), String> {
    let temp_path = lifecycle
        .pending_asset_uploads
        .lock()
        .map_err(|_| "无法锁定附件上传状态".to_string())?
        .get(&upload_id)
        .map(|upload| upload.temp_path.clone())
        .ok_or_else(|| format!("找不到附件上传任务: {upload_id}"))?;
    let bytes = BASE64_STANDARD
        .decode(base64_chunk.as_bytes())
        .map_err(|err| format!("无法解码附件上传分块: {err}"))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temp_path)
        .map_err(|err| format!("无法打开临时上传文件 {}: {err}", temp_path.display()))?;
    file.write_all(&bytes)
        .map_err(|err| format!("无法写入临时上传文件 {}: {err}", temp_path.display()))
}

#[tauri::command]
fn finish_asset_upload(
    app: AppHandle,
    lifecycle: State<AppLifecycleState>,
    upload_id: String,
    error: Option<String>,
) -> Result<(), String> {
    let pending = lifecycle
        .pending_asset_uploads
        .lock()
        .map_err(|_| "无法锁定附件上传状态".to_string())?
        .remove(&upload_id)
        .ok_or_else(|| format!("找不到附件上传任务: {upload_id}"))?;

    if let Ok(mut reserved) = lifecycle.pending_asset_imports.lock() {
        reserved.remove(&pending.target_path);
    }

    let result = if let Some(reason) = error {
        if pending.temp_path.exists() {
            let _ = fs::remove_file(&pending.temp_path);
        }
        Err(reason)
    } else {
        fs::rename(&pending.temp_path, &pending.target_path).map_err(|err| {
            format!(
                "无法完成附件上传 {} -> {}: {err}",
                pending.temp_path.display(),
                pending.target_path.display()
            )
        })
    };

    let payload = match result {
        Ok(()) => AssetImportStatusPayload {
            document_path: pending.document_path,
            relative_path: pending.relative_path,
            file_name: pending.file_name,
            status: "completed".to_string(),
            error: None,
        },
        Err(err) => AssetImportStatusPayload {
            document_path: pending.document_path,
            relative_path: pending.relative_path,
            file_name: pending.file_name,
            status: "failed".to_string(),
            error: Some(err),
        },
    };

    let _ = app.emit(ASSET_IMPORT_STATUS_EVENT, payload);
    Ok(())
}

#[tauri::command]
fn queue_asset_import_from_path(
    app: AppHandle,
    lifecycle: State<AppLifecycleState>,
    document_path: String,
    assets_dir: String,
    source_path: String,
    file_name: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("附件源文件不存在: {}", source.display()));
    }

    let default_name = if file_name
        .as_deref()
        .or_else(|| source.file_name().and_then(|value| value.to_str()))
        .map(|name| {
            Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| is_supported_image_extension(value))
                .is_some()
        })
        .unwrap_or(false)
    {
        "image.png"
    } else {
        "attachment.bin"
    };

    let effective_file_name = file_name
        .as_deref()
        .or_else(|| source.file_name().and_then(|value| value.to_str()));
    let (target_path, relative_path, display_name) = {
        let mut reserved = lifecycle
            .pending_asset_imports
            .lock()
            .map_err(|_| "无法锁定附件导入状态".to_string())?;
        let (document_dir, target_path) = resolve_asset_target_path(
            &document_path,
            &assets_dir,
            effective_file_name,
            default_name,
            Some(&reserved),
        )?;
        reserved.insert(target_path.clone());

        let relative_path = target_path
            .strip_prefix(&document_dir)
            .map_err(|err| format!("无法计算附件相对路径 {}: {err}", target_path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        let display_name = effective_file_name
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                target_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "attachment".to_string())
            });
        (target_path, relative_path, display_name)
    };

    let event_app = app.clone();
    let event_document_path = document_path.clone();
    let event_relative_path = relative_path.clone();
    std::thread::spawn(move || {
        let copy_result = fs::copy(&source, &target_path).map(|_| ());

        if let Ok(mut reserved) = event_app
            .state::<AppLifecycleState>()
            .pending_asset_imports
            .lock()
        {
            reserved.remove(&target_path);
        }

        let payload = match copy_result {
            Ok(()) => AssetImportStatusPayload {
                document_path: event_document_path,
                relative_path: event_relative_path,
                file_name: display_name,
                status: "completed".to_string(),
                error: None,
            },
            Err(err) => AssetImportStatusPayload {
                document_path: event_document_path,
                relative_path: event_relative_path,
                file_name: display_name,
                status: "failed".to_string(),
                error: Some(format!(
                    "无法复制附件文件 {} -> {}: {err}",
                    source.display(),
                    target_path.display()
                )),
            },
        };

        let _ = event_app.emit(ASSET_IMPORT_STATUS_EVENT, payload);
    });

    Ok(relative_path)
}

#[cfg(target_os = "windows")]
fn launch_local_path(path: &Path) -> Result<(), String> {
    Command::new("cmd")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开本地文件 {}: {err}", path.display()))
}

#[cfg(target_os = "macos")]
fn launch_local_path(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开本地文件 {}: {err}", path.display()))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn launch_local_path(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开本地文件 {}: {err}", path.display()))
}

#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("本地文件不存在: {}", target.display()));
    }

    launch_local_path(&target)
}

#[tauri::command]
fn request_app_exit(app: AppHandle, lifecycle: State<AppLifecycleState>) -> Result<(), String> {
    lifecycle.allow_exit.store(true, Ordering::SeqCst);

    if let Some(window) = app.get_webview_window("main") {
        window
            .close()
            .map_err(|err| format!("无法关闭应用窗口: {err}"))?;
    } else {
        app.exit(0);
    }

    Ok(())
}

#[tauri::command]
fn move_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "无法定位主窗口".to_string())?;

    let _ = window.minimize();
    window
        .hide()
        .map_err(|err| format!("无法隐藏主窗口: {err}"))?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            restore_main_window(app);

            let cwd = PathBuf::from(cwd);
            let markdown_files = collect_markdown_files(args, Some(cwd.as_path()));
            if !markdown_files.is_empty() {
                let _ = app.emit(OPEN_REQUESTED_MARKDOWN_FILES_EVENT, markdown_files);
            }
        }))
        .manage(AppLifecycleState::default())
        .setup(|app| {
            let show_item =
                MenuItem::with_id(app, TRAY_SHOW_ID, "显示 TinyMD", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, TRAY_QUIT_ID, "退出 TinyMD", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("missing default window icon")?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_SHOW_ID => {
                        restore_main_window(app);
                    }
                    TRAY_QUIT_ID => {
                        let _ = app.emit(TRAY_REQUEST_EXIT_EVENT, ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        restore_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let lifecycle = window.state::<AppLifecycleState>();
                    if lifecycle.allow_exit.load(Ordering::SeqCst) {
                        return;
                    }

                    api.prevent_close();
                    let _ = window.emit(APP_CLOSE_INTENT_EVENT, ());
                }
                _ => {}
            }
        })
        .on_webview_event(|webview, event| {
            if webview.label() != "main" {
                return;
            }

            let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
                return;
            };

            let normalized_paths = paths
                .iter()
                .filter(|path| path.is_file())
                .map(|path| normalize(path.clone()))
                .collect::<Vec<_>>();
            append_drag_debug_log(
                &webview.app_handle(),
                "webview-drag-drop",
                &format!(
                    "position=({}, {}), paths={normalized_paths:?}",
                    position.x, position.y
                ),
            );

            let markdown_paths = normalized_paths
                .iter()
                .filter(|path| is_markdown(Path::new(path)))
                .cloned()
                .collect::<Vec<_>>();
            let asset_paths = normalized_paths
                .iter()
                .filter(|path| !is_markdown(Path::new(path)))
                .cloned()
                .collect::<Vec<_>>();

            if !markdown_paths.is_empty() {
                append_drag_debug_log(
                    &webview.app_handle(),
                    "emit-open-dropped-markdown-files",
                    &format!("paths={markdown_paths:?}"),
                );
                let _ = webview
                    .window()
                    .emit(OPEN_DROPPED_MARKDOWN_FILES_EVENT, markdown_paths);
            }

            if !asset_paths.is_empty() {
                append_drag_debug_log(
                    &webview.app_handle(),
                    "emit-insert-dropped-asset-paths",
                    &format!("paths={asset_paths:?}"),
                );
                let _ = webview.window().emit(
                    INSERT_DROPPED_ASSET_PATHS_EVENT,
                    DroppedAssetPathsPayload {
                        paths: asset_paths,
                        position: DropPositionPayload {
                            x: position.x,
                            y: position.y,
                        },
                    },
                );
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_launch_markdown_files,
            read_markdown_file,
            save_markdown_file,
            load_editor_session,
            save_editor_session,
            open_external_url,
            open_local_path,
            open_file_location,
            read_image_data_url,
            read_local_asset_metadata,
            get_asset_directory_status,
            ensure_temporary_document_path,
            save_temporary_markdown_file,
            delete_temporary_document,
            save_asset,
            save_asset_from_path,
            begin_asset_upload,
            append_asset_upload_chunk,
            finish_asset_upload,
            queue_asset_import_from_path,
            request_app_exit,
            move_main_window_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
