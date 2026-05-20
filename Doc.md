# Agent-IM 打包文档

## 前置条件

- Node.js >= 20
- pnpm >= 10
- Windows 10/11

## 安装依赖

```bash
pnpm install
```

如果 Electron 未正确安装（提示 `Electron failed to install`），手动执行：

```bash
node node_modules/.pnpm/electron@35.7.5/node_modules/electron/install.js
```

## 开发模式

```bash
pnpm electron:dev
```

流程：编译 Electron TS 文件 -> 启动 Electron -> 内部自动启动 wrangler dev -> 打开桌面窗口。

## 打包为 Windows 安装程序

```bash
pnpm electron:build
```

输出目录：`release/`，生成 NSIS 安装包（`.exe`）。

## 打包原理

```
electron/main.ts    -- esbuild -->  dist-electron/main.js
electron/preload.ts -- esbuild -->  dist-electron/preload.js
                    -- electron-builder -->  release/*.exe
```

1. `scripts/build-electron.ts` 用 esbuild 将 `electron/` 下的 TS 编译为 CJS 格式到 `dist-electron/`
2. `electron-builder` 读取 `electron-builder.config.js` 配置，打包整个项目为 Windows NSIS 安装程序
3. 运行时 Electron 主进程 spawn `wrangler dev`，等待服务就绪后创建 BrowserWindow 加载 Web UI

## 配置文件说明

| 文件 | 作用 |
|------|------|
| `electron/main.ts` | Electron 主进程入口 |
| `electron/preload.ts` | 渲染进程 preload 脚本 |
| `scripts/build-electron.ts` | esbuild 编译脚本 |
| `electron-builder.config.js` | electron-builder 打包配置 |

## 相关脚本

| 命令 | 说明 |
|------|------|
| `pnpm electron:dev` | 开发模式运行桌面应用 |
| `pnpm electron:build` | 打包为 Windows exe 安装包 |

## 注意事项

- 打包产物在 `release/` 目录，已加入 `.gitignore`
- 编译中间文件在 `dist-electron/`，已加入 `.gitignore`
- 打包后的应用仍依赖 `wrangler`（包含在 node_modules 中一起打包）
- 如需修改打包目标（如 portable 免安装版），编辑 `electron-builder.config.js` 中 `win.target`
