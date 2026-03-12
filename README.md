# TinyMD

轻量级桌面 Markdown 编辑器，基于 `Tauri + React + TypeScript + Milkdown`。

A lightweight desktop Markdown editor built with `Tauri + React + TypeScript + Milkdown`.

## 界面 / Layout

- 顶部紧凑菜单栏与标签栏 / Compact top menu bar and tabs
- 中央 Markdown 编辑区，支持 `MD` 与原文模式切换 / Central Markdown editor with `MD` and source mode switching
- 底部状态栏，用于模式切换与状态提示 / Bottom status bar for mode switching and status messages

## 功能 / Features

- 多标签 Markdown 编辑 / Multi-tab Markdown editing
- `MD` 与原文模式切换 / Toggle between `MD` and source mode
- 打开、拖拽打开、保存本地 `.md` / `.markdown` 文件 / Open, drag in, and save local `.md` / `.markdown` files
- 自动恢复上次会话和临时文档 / Restore the previous session and temporary documents on launch
- 支持常用快捷键：`Ctrl/Cmd + N`、`Ctrl/Cmd + O`、`Ctrl/Cmd + S` / Supports common shortcuts: `Ctrl/Cmd + N`, `Ctrl/Cmd + O`, `Ctrl/Cmd + S`
- Markdown 链接使用系统默认浏览器打开 / Open Markdown links in the system default browser

## 开发 / Development

```bash
npm install
npm run tauri dev
```

## 构建 / Build

```bash
npm run tauri build
```

执行后会按照 Tauri 配置生成当前平台对应的桌面安装包或可执行文件。

This command generates platform-specific desktop bundles or executables based on the current Tauri configuration.

## License

MIT
