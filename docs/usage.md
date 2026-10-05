# 运行与使用指南

面向操作者：如何安装、配置、启动本服务，以及出问题怎么查。
产品与架构说明见 [DESIGN.md](../DESIGN.md)，实现细节见 [impl-notes/](impl-notes/index.md)。

## 环境要求

- Windows（当前唯一验证过的平台）
- Node.js **≥ 22.13**（本项目用内置 `node:sqlite`，故不再需要编译原生模块；
  实测环境为 Node 26）
- pnpm（工作区根目录）
- LM Studio（桌面版即可；本服务不下载模型，但会尝试定位并启动它）

## 安装

```powershell
pnpm install
pnpm build            # 共享契约 -> 前端产物 -> 后端
```

`pnpm-workspace.yaml` 里用 `allowBuilds` 放行了 `esbuild` 的安装脚本（pnpm 12 默认拦截
依赖的安装脚本）。若换机器后 `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`，按提示运行
`pnpm approve-builds` 即可。若安装时报
`thread '<unknown>' has overflowed its stack` 或仓库内校验锁文件供应链接连失败，
可用 `pnpm install --trust-lockfile` 跳过锁文件的供应链策略校验（本机验证过的方式）。

## 启动

最省事的方式（推荐）：在仓库根目录**双击 `run.cmd`**，或在 PowerShell 里执行

```powershell
.\run.ps1
```

脚本会自动完成：环境自检 → 首次运行装依赖 → 源码有改动就构建 → 检查 LM Studio
（没在跑就用 `lms server start` 尝试拉起）→ 在独立窗口启动后端 → 等服务就绪 →
打开浏览器。再次运行时会跳过构建，并在服务已在运行时直接给出界面地址。

可选参数：

```powershell
.\run.ps1 -Port 5175       # 换端口
.\run.ps1 -NoBrowser       # 不开浏览器
.\run.ps1 -SkipBuild       # 跳过构建检查（更快）
.\run.ps1 -ForceBuild      # 强制重新构建
```

停止服务：关闭后端窗口，或在界面上点"关闭服务"。界面里选"关闭服务"时，如果
LM Studio 是本服务启动的，会一并关闭；否则会先问你要不要一起关。

## 手动启动（等价命令）

```powershell
pnpm install          # 首次
pnpm build            # 共享契约 → 前端产物 → 后端
pnpm start            # 运行 apps/server/dist
```

启动后访问 **http://127.0.0.1:5174** 。

开发模式（前端热更新）：

```powershell
pnpm --filter @ots/server dev     # 后端（5174）
pnpm --filter @ots/web dev        # Vite（5173），/api 代理到 5174
```

启动顺序（`DESIGN.md` §3.3）：

1. 初始化数据库（首次启动自动创建"默认合集"并设为当前合集）。
2. 探测 `LMSTUDIO_BASE_URL`：可达则直接使用；否则定位并启动 LM Studio，最多等待
   `LMSTUDIO_STARTUP_TIMEOUT_MS`。
3. 启动 HTTP 服务并托管前端。

> 服务只监听回环地址，且**没有鉴权**（按设计单机单人使用）。不要改 `HOST` 把它暴露到
> 局域网。

## 配置

全部通过环境变量，默认值见 `DESIGN.md` §11。最常用的几个：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `PORT` | `5174` | 后端端口 |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234` | 推理端点 |
| `LMSTUDIO_EXE` | 自动定位 | 手动指定 `lms.exe` / `LM Studio.exe` |
| `LMSTUDIO_MODEL` | 取列表首个 | 指定模型 id |
| `LMSTUDIO_AUTOSTART` | `true` | 置 `false` 则只使用已在运行的 LM Studio |
| `LMSTUDIO_WARMUP` | `true` | 就绪后是否显式预加载模型 |
| `TRANSLATE_MAX_CHARS` | `10000` | 单次翻译原文长度上限 |
| `DB_PATH` | `apps/server/data/translations.db` | 历史数据库文件 |

## 日常使用

界面会**记住你的选择**（存在浏览器本地，换浏览器或清空浏览器数据后会回到默认）：

- **翻译方向**（中→英 / 英→中）：下次打开还是上次的方向；
- **历史每页条数**（20 / 50 / 100 / 200）：在"翻译历史"标题右侧切换，会一直沿用；
- **上次选中的合集**：后端本来就把当前合集记在数据库里；如果它在别处被切换过，本页面
  也会回到你上次选中的那个（该合集已被删除时自动忽略）。

原文、译文和历史记录**不会**存在浏览器本地——它们要么是你正在编辑的内容，要么已经在
后端数据库里。

- **合集**：左栏新建、切换、重命名、删除。删除合集会级联删除其下所有历史；删掉当前合集
  会自动切到最近使用的合集（没有则新建"默认合集"）。
- **翻译**：右栏上方选择方向（中→英 / 英→中），输入原文，点"翻译"（或 `Ctrl+Enter`）。
  译文会流式显示在**输入框下方的"译文"输出框**里，完成后保留，可点"复制"取走；点"清空"
  只清空输出框，不影响已保存的历史。同一个合集同一时刻只允许一个翻译在跑。
- **多选删除**：
  - 勾选框 = 只选中该行；
  - 普通点行 = 只选中该行；
  - `Ctrl+点击` = 切换该行（不连续多选）；
  - `Shift+点击` = 从锚点行到该行整段选中；
  - 表头勾选框 / 列表聚焦时 `Ctrl+A` = 全选当前页；`Delete` = 批量删除。
  - 删除前会二次确认。
- **同一个合集同一时刻只能有一个翻译在跑**：翻译进行中"翻译"按钮与方向切换会禁用；不同
  合集可以同时翻译。
- **关闭**：
  - "关闭服务"：若 LM Studio 是本服务启动的，直接一并关闭；否则弹窗询问是否同时关闭。
  - "仅关闭 LM Studio"：只释放显存，后端继续运行以便浏览历史；若 LM Studio 不是本会话
    启动的，会先请求确认。
  - 直接 `Ctrl+C` 关终端：本会话启动的 LM Studio 会被一起关闭；本来就在运行的 LM Studio
    保持运行（不会动它）。

## 排障

| 现象 | 处理 |
| --- | --- |
| 页面提示"前端尚未构建" | 运行 `pnpm build:web` 后刷新 |
| 翻译报 `LMSTUDIO_UNAVAILABLE` | 确认 LM Studio 已启动且本地服务器开着（`lms server status`）；确认 `LMSTUDIO_BASE_URL` 端口正确；在状态栏点"重试" |
| 第一条翻译很慢（几十秒） | 模型冷加载。保持 `LMSTUDIO_WARMUP=true`，或在 LM Studio 里手动加载模型；也可调大 `LMSTUDIO_LOAD_TIMEOUT_MS` / 推理请求超时 |
| 启动日志"未能定位 LM Studio" | 用 `LMSTUDIO_EXE` 指定路径，或安装官方 CLI（`lms.exe`，位于 `%USERPROFILE%\.lmstudio\bin`） |
| 报 `INPUT_TOO_LONG` | 原文超过 `TRANSLATE_MAX_CHARS`（默认 10000 字符）；调大该变量或分段翻译 |
| 报 `TRANSLATION_IN_FLIGHT` | 同一合集的翻译还没结束；等待或换一个合集 |
| "关闭服务"后想继续用 | 后端进程已退出，重新运行 `pnpm start` |
| 端口 5174 被占用 | 改 `PORT`，或结束占用该端口的进程（先用 `netstat -ano -p tcp \| findstr :5174` 确认 PID，不要按进程名批量清理） |

## 数据与隐私

- 历史记录是私人内容，存放在 `apps/server/data/translations.db`（已被 `.gitignore` 忽略，
  连同 WAL 文件）。**不要提交它，也不要在 issue / 文档 / 测试里粘贴真实译文。**
- 默认不记录原文与译文，只记录状态码与规模。
- 想清空历史：在界面上删除条目或合集；数据库文件本身请勿在服务运行时手工删改。
