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

## 架构文档 / Architecture Notes

- 编辑器架构、Milkdown 改造点、mac / Windows 平台适配边界见 [docs/editor-architecture.md](./docs/editor-architecture.md)

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

## 版本与发布约定 / Versioning & Release

- 当前使用 `beat` 节奏版本号：`1.0.0-beat.N`
- Git tag 统一使用带 `v` 前缀的同版本号：`v1.0.0-beat.N`
- 每次发布时，以下文件中的版本号必须保持一致：
  - `package.json`
  - `package-lock.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock`
  - `src-tauri/tauri.conf.json`
- 每次发布都要在 [CHANGELOG.md](./CHANGELOG.md) 增加对应版本摘要
- 建议的发布提交信息：
  - 版本提交：`Release beat.N`
  - 如果构建后 `Cargo.lock` 发生同步变更，可单独提交：`chore: sync Cargo.lock for beat.N`

当前仓库默认只保证 `exe` 产物发布流程：

```bash
npx tauri build --no-bundle
```

- `beat.N` 这种预发布版本号可以正常生成 `exe`
- 但 Windows MSI 不接受 `beat.5` 这类预发布标识，因此当前 `beat` 版本默认不生成 MSI
- 如果后续需要 MSI，必须先改成 Windows MSI 可接受的版本规则

Recommended release sequence:

1. Update the version files listed above to `1.0.0-beat.N`
2. Add a matching entry to `CHANGELOG.md`
3. Commit the release changes
4. Build the executable with `npx tauri build --no-bundle`
5. Create the git tag `v1.0.0-beat.N`
6. Publish the built `.exe` through GitHub Release if needed

## License

MIT
