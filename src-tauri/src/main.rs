#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
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
const DEFAULT_IMAGE_DIR: &str = "assets";

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

fn sanitize_image_stem(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    for ch in value.trim().chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || ch.is_control()
        {
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

fn build_unique_image_path(target_dir: &Path, file_name: Option<&str>) -> PathBuf {
    let preferred_name = file_name.unwrap_or("image.png");
    let preferred_path = Path::new(preferred_name);
    let stem = preferred_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_image_stem)
        .unwrap_or_else(|| "image".to_string());
    let extension = preferred_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| is_supported_image_extension(value))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "png".to_string());

    let mut index = 0usize;
    loop {
        let file_name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = target_dir.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
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

fn assign_temp_doc_path(app: &AppHandle, tab: &mut EditorTabState) -> Result<(), String> {
    tab.path = Some(normalize(temp_doc_path(app, &tab.id)?));
    Ok(())
}

fn replace_asset_reference(content: String, old_path: &str, new_path: &str) -> String {
    content
        .replace(&format!("({old_path})"), &format!("({new_path})"))
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
    fs::create_dir_all(target_doc_dir).map_err(|err| {
        format!(
            "无法创建文档目录 {}: {err}",
            target_doc_dir.display()
        )
    })?;

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

            let relative_source = source_path
                .strip_prefix(temp_doc_dir)
                .map_err(|err| {
                    format!(
                        "无法计算临时资源相对路径 {}: {err}",
                        source_path.display()
                    )
                })?;
            let destination_path = target_doc_dir.join(relative_source);
            let destination_dir = destination_path
                .parent()
                .ok_or_else(|| format!("无法定位目标资源目录: {}", destination_path.display()))?;
            fs::create_dir_all(destination_dir).map_err(|err| {
                format!(
                    "无法创建目标资源目录 {}: {err}",
                    destination_dir.display()
                )
            })?;

            let final_destination = if destination_path.exists() {
                build_unique_image_path(
                    destination_dir,
                    destination_path.file_name().and_then(|value| value.to_str()),
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

    for tab in session.tabs.iter().filter(|tab| tab.temporary) {
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
                fs::remove_dir_all(&path).map_err(|err| {
                    format!("无法删除旧临时文档目录 {}: {err}", path.display())
                })?;
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
            assign_temp_doc_path(&app, &mut tab)?;

            if is_requested_active {
                restored_active_id = Some(tab.id.clone());
            }

            restored_tabs.push(into_loaded_tab(tab, true));
            continue;
        }

        let Some(path) = tab.path.clone() else {
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

#[tauri::command]
fn read_image_data_url(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("图片文件不存在: {}", target.display()));
    }

    let mime_type = image_mime_type(&target)
        .ok_or_else(|| format!("不支持的图片格式: {}", target.display()))?;
    let bytes = fs::read(&target)
        .map_err(|err| format!("无法读取图片文件 {}: {err}", target.display()))?;
    let encoded = BASE64_STANDARD.encode(bytes);
    Ok(format!("data:{mime_type};base64,{encoded}"))
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
fn save_image_asset(
    document_path: String,
    assets_dir: String,
    file_name: Option<String>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let document = PathBuf::from(&document_path);
    if !is_markdown(&document) {
        return Err(format!("仅支持为 Markdown 文档保存图片: {document_path}"));
    }

    let document_dir = document
        .parent()
        .ok_or_else(|| format!("无法定位文档目录: {}", document.display()))?;
    let relative_dir = sanitize_image_dir(&assets_dir)?;
    let target_dir = document_dir.join(&relative_dir);
    fs::create_dir_all(&target_dir)
        .map_err(|err| format!("无法创建图片目录 {}: {err}", target_dir.display()))?;

    let target_path = build_unique_image_path(&target_dir, file_name.as_deref());
    fs::write(&target_path, bytes)
        .map_err(|err| format!("无法写入图片文件 {}: {err}", target_path.display()))?;

    let relative_path = target_path
        .strip_prefix(document_dir)
        .map_err(|err| format!("无法计算图片相对路径 {}: {err}", target_path.display()))?;

    Ok(relative_path.to_string_lossy().replace('\\', "/"))
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
            open_file_location,
            read_image_data_url,
            ensure_temporary_document_path,
            save_temporary_markdown_file,
            delete_temporary_document,
            save_image_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
