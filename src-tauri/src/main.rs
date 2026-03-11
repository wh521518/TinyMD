use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeNode {
    name: String,
    path: String,
    kind: NodeKind,
    children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum NodeKind {
    File,
    Folder,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTree {
    root_name: String,
    root_path: String,
    nodes: Vec<TreeNode>,
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("md") | Some("markdown")
    )
}

fn normalize(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn build_tree(root: &Path) -> Result<Vec<TreeNode>, String> {
    let mut entries = fs::read_dir(root)
        .map_err(|err| format!("无法读取目录 {}: {err}", root.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("无法遍历目录 {}: {err}", root.display()))?;

    entries.sort_by_key(|entry| entry.path());

    let mut folders = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
      let path = entry.path();
      let name = entry.file_name().to_string_lossy().to_string();

      if path.is_dir() {
          folders.push(TreeNode {
              name,
              path: normalize(path.clone()),
              kind: NodeKind::Folder,
              children: Some(build_tree(&path)?),
          });
      } else if is_markdown(&path) {
          files.push(TreeNode {
              name,
              path: normalize(path),
              kind: NodeKind::File,
              children: None,
          });
      }
    }

    folders.extend(files);
    Ok(folders)
}

#[tauri::command]
fn load_workspace_tree(root_path: String) -> Result<WorkspaceTree, String> {
    let root = PathBuf::from(&root_path);
    if !root.exists() {
        return Err(format!("目录不存在: {}", root.display()));
    }

    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_string();

    Ok(WorkspaceTree {
        root_name,
        root_path: normalize(root.clone()),
        nodes: build_tree(&root)?,
    })
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|err| format!("无法读取文件 {path}: {err}"))
}

#[tauri::command]
fn save_markdown_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|err| format!("无法保存文件 {path}: {err}"))
}

#[tauri::command]
fn create_markdown_file(parent_path: String, file_name: String) -> Result<String, String> {
    let file_path = PathBuf::from(parent_path).join(file_name);
    if file_path.exists() {
        return Err(format!("文件已存在: {}", file_path.display()));
    }

    fs::write(&file_path, "# 新文档\n").map_err(|err| format!("无法创建文件: {err}"))?;
    Ok(normalize(file_path))
}

#[tauri::command]
fn create_folder(parent_path: String, folder_name: String) -> Result<(), String> {
    let folder_path = PathBuf::from(parent_path).join(folder_name);
    fs::create_dir_all(&folder_path).map_err(|err| format!("无法创建目录: {err}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_workspace_tree,
            read_markdown_file,
            save_markdown_file,
            create_markdown_file,
            create_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
