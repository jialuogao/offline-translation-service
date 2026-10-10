# 离线翻译服务 / Offline Translation Service

本机离线运行的中英互译服务。浏览器打开 Web 客户端，后端通过 LM Studio 的
OpenAI 兼容端点调用本地模型推理，翻译历史按"合集（Collection）"组织。

没有云依赖，没有账号系统，单机单人使用。

## 架构概览

```text
浏览器 Web 客户端 (React SPA)
   │  REST /api                │  SSE /api/translate/stream
   v                           v
后端 (Node.js + Express，单进程)
   ├─ CollectionService / TranslationService
   ├─ SQLite (Node 内置 node:sqlite) -> apps/server/data/translations.db
   └─ LMStudioAdapter  ->  LMStudioProcessManager
                                 │
                                 v
                        LM Studio (127.0.0.1:1234)
                        已加载本地翻译模型
```

## 功能要点

- 中 → 英 / 英 → 中 双向翻译，流式输出
- 输入框下方有独立的**译文输出框**，流式实时增长、完成后保留，可一键复制
- 界面记住你的选择：翻译方向、历史每页条数、上次选中的合集
- 合集管理：新建、切换、重命名、删除（删除合集级联其历史）
- 历史记录：分页浏览、单条删除、Shift / Ctrl 多选批量删除、清空合集
- LM Studio 生命周期托管：启动时自动拉起**本地服务器**并加载模型（验证 + 重试最多 3 次，
  不打开图形界面）；关闭时只**卸载模型**释放内存，不终止 LM Studio，服务器继续运行
- 统一健康状态端点 `GET /api/service/status`：db / storage / lmstudio 各模块状态如实汇报，
  模型加载失败不会拖垮界面（合集/历史照常可用）
- 回归测试使用 Mock LM Studio，不依赖真实模型与实例

## 快速开始

一键启动（推荐）：双击仓库根目录的 **`run.cmd`**，或在 PowerShell 里运行

```powershell
.\run.ps1          # 自检环境、必要时安装与构建、启动后端并等待模型就绪、开浏览器
```

由其它项目程序化调度时，配合关闭脚本使用（两步都需要）：

```powershell
pwsh -File run.ps1 -NoBrowser -Port 5197     # 启动（-NoBrowser 必须带）
pwsh -File shutdown.ps1 -Port 5197           # 优雅关闭：卸载模型 → 关库 → 退出
```

手动启动：

```powershell
pnpm install
pnpm build
pnpm start          # 打开 http://127.0.0.1:5174
```

详细步骤、参数、配置项与排障见 [运行与使用指南](docs/usage.md)。

## 环境要求

- Windows（主要目标平台）
- Node.js ≥ 22.13（使用 Node 内置 `node:sqlite`，无需编译原生模块）
- pnpm（工作区根目录）
- LM Studio 及本机已加载的翻译模型（本服务不负责下载模型）

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `.\run.ps1` / `run.cmd` | 一键启动：自检 → 安装/构建 → 起服务 → 等模型就绪（重试 3 次，失败会提示）→ 开浏览器 |
| `.\shutdown.ps1` | 程序化关闭：卸载模型 → 关库 → 退出；供其它项目调用 |
| `pnpm build` | 构建共享契约 → 前端产物 → 后端 |
| `pnpm start` | 启动后端（需先构建） |
| `pnpm dev` | 构建前端后用 tsx 监听后端源码 |
| `pnpm test` | 运行 Vitest 回归测试（使用 Mock，不起真实 LM Studio） |
| `pnpm test:e2e` | 用真实 LM Studio 跑端到端翻译测试（需模型已加载；单独执行，不并入 `pnpm test`） |
| `pnpm typecheck` | 全工作区类型检查 |

## 文档

- [设计文档](DESIGN.md) — 需求、架构、数据模型、API/SSE 契约、测试策略、里程碑
- [运行与使用指南](docs/usage.md) — 安装、配置、启动、界面操作、排障
- [实现笔记](docs/impl-notes/index.md) — 各子系统的已核实实现细节（英文）
- [文档索引](docs/index.md) — 全部文档的入口
- [仓库约定](AGENTS.md) — 面向贡献者与 agent 的规则
