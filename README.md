# Rust Milkdown

基于 `Tauri + React + TypeScript + Milkdown` 的桌面 Markdown 编辑器。

## 已实现

- 左侧工作区文档/文件夹树
- 中间 Milkdown 编辑器
- 右侧文章目录
- 多 Tab 编辑
- 本地 Markdown 文件读取、保存、新建文档、新建文件夹
- `Ctrl + S` / `Cmd + S` 保存

## 启动

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build -- --debug
```

打包产物位于：

- `E:\+A-Project\rust-milkdown\src-tauri\target\release\bundle\msi`
- `E:\+A-Project\rust-milkdown\src-tauri\target\release\bundle\nsis`
