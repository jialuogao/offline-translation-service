# 本地翻译服务设计文档

> 离线中英互译服务，本地模型推理，Web 客户端，翻译历史按"合集"组织。
> 本文档定大方向与接口契约，留给 implementation agent 实现。

---

## 1. 概述

### 1.1 目标

- 本地运行的中英双向翻译服务，使用本地大模型推理，不依赖云服务。
- Web 客户端，浏览器访问。
- 翻译历史按"合集（Collection）"组织；可新建合集、切换合集、删除合集。
- 合集内每条翻译记录可单独删除；支持 Shift / Ctrl 多选删除。
- 后端在启动时自动接管 LM Studio：若已在运行则直接使用；否则启动之。
- 关闭服务时：若 LM Studio 是本会话启动的则一并关闭；否则询问用户是否关闭。
- 回归测试使用 Mock API，不依赖 LM Studio 实例。

### 1.2 模型与推理后端

- 推理后端：LM Studio（OpenAI 兼容端点，默认 `http://127.0.0.1:1234`）。
- 模型：`alphaZimuth/Hy-MT2-30B-A3B-Uncensored-v1-APEX-GGUF`
  - 基于 Tencent Hy-MT2-30B-A3B 的 36 语言翻译 MoE，APEX 量化 GGUF。
  - 用户在下载中；本服务不负责下载，假定用户已在 LM Studio 中加载该模型（或任一可用模型）。
  - 架构 `hy_v3`，需 llama.cpp b9993+（LM Studio 新版本已支持）。
- 推理通过 OpenAI 兼容的 `POST /v1/chat/completions` 调用，支持 `stream: true` 流式返回。

### 1.3 非目标

- 不做云端部署、不做多用户鉴权（单机本地使用）。
- 不做模型自动下载 / 量化管理（由 LM Studio 负责）。
- 不做除中英之外其他语言的 UI（模型支持，但 UI 仅暴露 中→英 / 英→中；可后续扩展）。

---

## 2. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 后端 | Node.js（≥20 LTS）+ Express (`^4.18`) | 单进程 HTTP 服务，REST + SSE 流式；Express 5 已稳定但部分中间件生态滞后，默认 4.x |
| 数据库 | SQLite（**Node 内置 `node:sqlite`**） | 同步 API，单文件，适合本地。**实现期变更**：原定 `better-sqlite3` 在本机装不上（Node 26 无预编译产物、本机无 Visual Studio C++ 工具链，`prebuild-install` 回退 node-gyp 失败），改用 Node 24+ 内置的 `node:sqlite`（`DatabaseSync`，同样是同步 API），源码在 `apps/server/src/db/sqlite.ts` 里做了一层薄适配 |
| 前端 | React 18 + Vite + TypeScript | 单页应用 |
| 前端样式 | 原生 CSS / 轻量组件 | 不引入重量级 UI 框架，保持多选交互可控 |
| LM Studio 客户端 | `fetch` 封装 OpenAI 兼容端点 | 不引入 `openai` SDK，减少依赖 |
| 测试 | Vitest（单测）+ Mock LM Studio | 回归测试不依赖真实 LM Studio |
| 包管理 | pnpm | 与现有 DSH 生态一致；pnpm 12 默认拦截依赖安装脚本，需在 `pnpm-workspace.yaml` 里用 `allowBuilds` 放行 `esbuild` |

> 实现时可微调（如改用 Fastify、改用 `openai` SDK），但不得改变架构分层与接口契约。

---

## 3. 架构

### 3.1 组件总览

```
┌──────────────────────────────────────────────────────────┐
│                      浏览器 (Web Client)                  │
│  React SPA: 合集切换 / 翻译输入 / 历史列表 / 多选删除      │
└───────────────┬──────────────────────────┬──────────────┘
                │ REST (/api)               │ SSE (/api/translate/stream)
                ▼                           ▼
┌──────────────────────────────────────────────────────────┐
│                       后端 (Node/Express)                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Collection  │  │  Translation │  │  LMStudioAdapter │  │
│  │  Service    │  │   Service    │  │  (OpenAI compat)  │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                │                    │            │
│         ▼                ▼                    │            │
│  ┌─────────────────────────────┐              │            │
│  │      SQLite (node:sqlite)   │              │            │
│  └─────────────────────────────┘              │            │
│                                                │            │
│  ┌─────────────────────────────────────────────▼────────┐  │
│  │           LMStudioProcessManager                    │  │
│  │  - 启动时探测 127.0.0.1:1234                          │  │
│  │  - 未运行则 spawn lmstudio.exe，记录 PID              │  │
│  │  - 关闭时按 PID 归属决定关闭或询问                      │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │   LM Studio (127.0.0.1:1234) │
                    │   已加载 Hy-MT2-30B-A3B GGUF │
                    └──────────────────────────┘
```

### 3.2 模块职责

| 模块 | 职责 | 关键约束 |
| --- | --- | --- |
| `LMStudioProcessManager` | LM Studio 进程生命周期：探测、启动、归属判定、关闭 | 仅在启动/关闭时介入；推理期不参与 |
| `LMStudioAdapter` | 封装 OpenAI 兼容端点：列模型、chat completions（含流式） | 唯一与 LM Studio HTTP 交互的模块；可被 Mock 替换 |
| `TranslationService` | 翻译业务：构造 prompt、调 adapter、流式回写、落库历史 | 翻译方向、prompt 模板在此维护 |
| `CollectionService` | 合集 CRUD、合集内历史查询/删除（含批量） | 所有数据经此层，不直连 DB |
| `Db` | SQLite 连接、schema、迁移 | 同步 API；单例 |
| `Web Server` | 静态资源 + REST + SSE 路由 | 前端构建产物由其托管 |
| `Web Client` | SPA：合集管理、翻译、历史、多选 | 单页；SSE 接收流式译文 |

### 3.3 启动流程

1. 初始化 DB（建表/迁移）。
2. `LMStudioProcessManager.startup()`：
   1. 探测 `http://127.0.0.1:1234/v1/models`（带超时，最多重试 N 次）。
   2. 若可达：`sessionStartedByUs = false`，直接使用。
   3. 若不可达：定位 `lmstudio.exe`（见 §6.2），`spawn` 启动，记录子进程 PID；轮询 `/v1/models` 直到就绪或超时。
   4. 记录 `sessionStartedByUs` 与 PID，供关闭时决策。
3. 启动 HTTP 服务，托管前端。

### 3.4 关闭流程

关闭分两类场景，行为不同：

**A. 用户经前端主动"关闭服务"**（推荐路径，可触达用户）：

1. 前端先调 `GET /api/lmstudio/status` 取 `startedByUs`。
2. `startedByUs === true`：直接调 `POST /api/shutdown`，后端 kill LM Studio（按 PID）→ 关 DB → 退出，前端不必弹窗。
3. `startedByUs === false`：前端弹窗"是否同时关闭 LM Studio？"。
   - 用户选"是"：调 `POST /api/shutdown` 带 `{ closeLmStudio: true }`，后端按端口关联 PID 尽力终止 LM Studio（允许失败）→ 关 DB → 退出。
   - 用户选"否"：调 `POST /api/shutdown` 带 `{ closeLmStudio: false }`，LM Studio 保持运行，后端关 DB 退出。

**B. 后端直接收到 SIGINT/SIGTERM（用户 Ctrl-C、关终端、kill 进程）**：

- 不询问（无法触达用户）。
- `startedByUs === true`：kill LM Studio（按 PID）。
- `startedByUs === false`：跳过 LM Studio，关 DB 退出。
- 前端通过轮询 `/api/lmstudio/status` 感知服务已断开（连接被拒）。

> 设计意图：只有用户主动关闭时才有"询问外部 LM Studio"的交互；信号路径无法可靠完成 HTTP 往返，故按归属直接决策。`startedByUs === false` 下不自动关外部进程，是 §6.4 的硬约束，本流程不违背。

---

## 4. 数据模型

SQLite 单文件 `data/translations.db`。时间戳存为 ISO 8601 字符串（UTC）。

### 4.1 表结构

#### `collections`
| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID v4 |
| `name` | TEXT | NOT NULL | 用户可编辑；默认"未命名合集" |
| `created_at` | TEXT | NOT NULL | ISO8601 UTC |
| `updated_at` | TEXT | NOT NULL | 每次"切换为当前"或其下新增/删除记录时更新 |

#### `entries`（翻译历史条目）
| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID v4 |
| `collection_id` | TEXT | FK→collections.id, ON DELETE CASCADE | 所属合集 |
| `source_lang` | TEXT | NOT NULL | `zh` \| `en` |
| `target_lang` | TEXT | NOT NULL | `zh` \| `en`，且 ≠ source_lang |
| `source_text` | TEXT | NOT NULL | 原文 |
| `target_text` | TEXT | NOT NULL | 译文 |
| `model_id` | TEXT | | LM Studio 返回的 model identifier |
| `created_at` | TEXT | NOT NULL | ISO8601 UTC |

#### `meta`（单行键值，存全局状态）
| 列 | 类型 | 说明 |
| --- | --- | --- |
| `key` | TEXT PK | 如 `active_collection_id` |
| `value` | TEXT | |

> 不单独建"当前合集"表；当前合集 id 存 `meta['active_collection_id']`。

### 4.2 初始数据

- 首次启动若 `collections` 为空：自动创建一个"默认合集"并设为 active。

---

## 5. API 契约

所有 REST 端点前缀 `/api`，JSON 请求/响应。SSE 端点单独说明。
错误统一为 `{ "error": "<code>", "message": "<human>" }`，HTTP 状态码语义化。

### 5.1 合集

| 方法 | 路径 | 说明 | 请求体 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/collections` | 列出所有合集（按 updated_at desc） | — | `Collection[]` |
| POST | `/api/collections` | 新建合集 | `{ name?: string }` | `Collection`（201） |
| GET | `/api/collections/active` | 取当前合集 | — | `{ collection: Collection }` |
| PUT | `/api/collections/active` | 切换当前合集 | `{ id: string }` | `{ collection: Collection }` |
| PATCH | `/api/collections/:id` | 重命名 | `{ name: string }` | `Collection` |
| DELETE | `/api/collections/:id` | 删除合集（级联其下条目） | — | `200 { collection: Collection }`（删除后的新 active 合集；若删的是 active，自动切到剩余第一个或新建默认并在此返回） |

`Collection = { id, name, created_at, updated_at, entry_count: number }`

### 5.2 翻译历史

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/collections/:id/entries` | 列条目（created_at desc） | query: `?page=1&pageSize=50` | `{ items: Entry[], total: number, page, pageSize }` |
| DELETE | `/api/entries/:id` | 删单条 | — | `204` |
| POST | `/api/entries/batch-delete` | 批量删 | `{ ids: string[] }` | `{ deleted: number }` |
| DELETE | `/api/collections/:id/entries` | 清空合集（保留合集本身） | — | `{ deleted: number }` |

`Entry = { id, collection_id, source_lang, target_lang, source_text, target_text, model_id, created_at }`

### 5.3 翻译（流式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/translate/stream` | SSE 流式翻译 |

请求体：
```json
{
  "collection_id": "uuid",
  "source_lang": "zh",
  "target_lang": "en",
  "source_text": "要翻译的文本"
}
```
- `source_text` 长度上限由 `TRANSLATE_MAX_CHARS`（默认 10000 字符）控制；超出返回 `400 { error: "INPUT_TOO_LONG", message: "..." }`，不发起翻译。

SSE 事件序列（`Content-Type: text/event-stream`）：
```
event: delta
data: {"text": "Trans"}

event: delta
data: {"text": "lation"}

event: done
data: {"entry_id": "uuid", "target_text": "Translation", "model_id": "..."}
```

错误事件（与 REST 错误同形，§5 统一形状）：
```
event: error
data: {"error": "LMSTUDIO_UNAVAILABLE", "message": "无法连接 LM Studio"}
```

行为：
1. 校验 `collection_id` 存在、方向合法。
2. 构造翻译 prompt（见 §7）。
3. 调 `LMStudioAdapter.chatCompletion({ stream: true })`。
4. 每个 chunk 发 `delta` 事件（累积原文到译文）。
5. 流结束后将完整条目写入 `entries`，更新合集 `updated_at`，发 `done` 事件（含 `entry_id`）。
6. 任一步出错发 `error` 事件并终止。

> 流式期间不落库；只在 `done` 时一次性写入，避免半成品。

### 5.4 LM Studio 状态与服务关闭

| 方法 | 路径 | 说明 | 请求体 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/lmstudio/status` | 探测状态 | — | `{ running: boolean, startedByUs: boolean, modelLoaded?: string, pid?: number }` |
| GET | `/api/lmstudio/models` | 列已加载模型 | — | `{ models: string[] }` |
| POST | `/api/lmstudio/shutdown` | **仅关闭 LM Studio**（不关后端），用于用户想释放 GPU 内存但继续浏览历史 | — | `{ ok: boolean }`（若非本会话启动则返回 409，前端据此弹窗；确认后带 `{ force: true }` 重试，按端口关联 PID 尽力终止） |
| POST | `/api/shutdown` | **关闭整个服务**（含 LM Studio 处理） | `{ closeLmStudio?: boolean }` | `{ ok: boolean }` 后随即进程退出 |

端点语义（与 §3.4 配合）：

- `startedByUs` 字段供前端在关闭服务时决定是否弹"是否同时关闭 LM Studio"。
- `POST /api/shutdown`：`closeLmStudio` 仅在 `startedByUs === false` 时有意义（决定是否尽力关外部 LM Studio）；`startedByUs === true` 时后端无视此参数，始终按 PID 关闭本会话启动的 LM Studio。
- `POST /api/lmstudio/shutdown` 与 `/api/shutdown` 互不替代：前者只关 LM Studio 且后端继续运行，后者关整个服务。

---

## 6. LM Studio 生命周期

### 6.1 探测协议

- 端点：`GET http://127.0.0.1:1234/v1/models`，单次超时 2s。
- 启动时连续探测：默认总超时 60s（30B 模型冷加载可能超过 30s），由 `LMSTUDIO_STARTUP_TIMEOUT_MS` 控制；间隔由 `LMSTUDIO_PROBE_INTERVAL_MS` 控制，默认 1000ms。
- 采用指数退避更友好：前 10 次按 `LMSTUDIO_PROBE_INTERVAL_MS`，之后 ×2，上限 3000ms，直到耗尽总超时。
- 任一次返回 200 且 JSON 合法即视为就绪。

### 6.2 定位 `lmstudio.exe`

> **实现期实测结论（2026，本机 LM Studio 桌面版）**：
> - `LM Studio.exe --help` 无任何输出，桌面版**没有** `server start` 子命令（原 §6.3 的猜测不成立）；
> - 官方 CLI 是 `%USERPROFILE%\.lmstudio\bin\lms.exe`，支持 `lms server start` / `server status`；
> - 注册表 `HKCU\Software\LM Studio`、`HKCU\Software\LMStudio` 等键**均不存在**，注册表这条路径在本机无效；
> - 默认安装路径 `%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe` 存在。
>
> 因此实际优先级为：`LMSTUDIO_EXE` → `lms.exe`（`PATH` / `%USERPROFILE%\.lmstudio\bin` / 若干安装目录）
> → 桌面版 `LM Studio.exe` 主程序 → 注册表（保留但排最后，键不存在时不产生副作用）。

优先级（Windows）：
1. 环境变量 `LMSTUDIO_EXE`（用户可覆盖）。
2. `lms` CLI：`where lms` / `%USERPROFILE%\.lmstudio\bin\lms.exe` / `%LOCALAPPDATA%` 下的候选路径。
3. 桌面版主程序默认安装路径探测：
   - `%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe`
   - `%PROGRAMFILES%\LM Studio\LM Studio.exe`
   - `%PROGRAMFILES(X86)%\LM Studio\LM Studio.exe`
4. 注册表查询 LM Studio 安装路径（`HKCU\Software\LM Studio` 或类似）；本机实测无此键。

> 实现说明：定位失败时后端仍可启动，但翻译会返回 `LMSTUDIO_UNAVAILABLE`；前端展示引导。

### 6.3 启动

- `lms.exe`：`spawn(exePath, ['server', 'start'], { windowsHide: true, detached: false })`
  （本机实测支持，`lms server status` 亦可用）。
- 桌面版主程序（仅在没有 `lms` CLI 时作为兜底）：直接 `spawn(exePath)`，依赖其"启动时自动开 server"设置。
- `windowsHide: true` 默认隐藏 console 窗口；可通过 `LMSTUDIO_SHOW_CONSOLE=true` 显示（调试用）。
- 记录 `childProcess.pid` 与 `sessionStartedByUs = true`。
- 监听 `childProcess` exit：若在服务运行期间 LM Studio 被外部关闭，标记 `running=false` 并允许后续重试启动。

### 6.4 关闭归属判定

- `sessionStartedByUs === true`：关闭服务（`POST /api/shutdown`）或单独关 LM Studio（`POST /api/lmstudio/shutdown`）时，直接 `taskkill /PID <pid> /T /F`（Windows）。
- `sessionStartedByUs === false`：
  - 后端不主动关闭；`GET /api/lmstudio/status` 暴露 `startedByUs` 让前端知情。
  - 用户经前端触发关闭时（"关闭服务"或"单独关 LM Studio"），前端据 `startedByUs` 决定是否弹窗询问；用户确认后：
    - 关整个服务：调 `POST /api/shutdown` 带 `{ closeLmStudio: true }`。
    - 单独关 LM Studio：调 `POST /api/lmstudio/shutdown` 带 `{ force: true }`。
  - 两种情况下后端都按 `http://127.0.0.1:1234` 关联的 PID 终止；**终止前校验该 PID 的进程名确为 LM Studio，避免误杀占用同端口的其他进程**；失败则静默——已尽力。
    - 实测：`Get-NetTCPConnection -LocalPort 1234` 在普通用户会话下报"拒绝访问"，因此以 `netstat -ano -p tcp` 为主路径，PowerShell 版本作为兜底。
    - 进程名校验用 `tasklist /FI "PID eq <pid>" /FO CSV /NH`，映像名或窗口会话名匹配 `LM Studio` 才继续。
  - 信号路径（SIGINT，§3.4-B）下 `startedByUs === false` 直接跳过，不关外部 LM Studio。

### 6.5 不可达时的降级

- 启动探测超时且定位/启动失败：服务仍启动，`/api/translate/stream` 立即返回 `error: LMSTUDIO_UNAVAILABLE`；前端展示"LM Studio 未就绪，请手动启动并加载模型"。
- 运行期失联：`LMStudioAdapter` 调用失败时返回该 code；前端可点"重试"。

---

## 7. 翻译 Prompt 与流式

### 7.1 Prompt 模板（chat completions）

System：
```
You are a professional translator. Translate the user's text from {source_lang_name} to {target_lang_name}.

Rules:
- Output only the translation, with no explanations, no quotes, no extra commentary.
- Preserve formatting, code blocks, URLs, and proper nouns as-is unless they are clearly part of the translatable text.
- If the input is already in the target language, output it unchanged.
```

User：原文原文文本（按段落原样）。

- `source_lang_name` / `target_lang_name`：`zh → "Chinese"`, `en → "English"`。
- 参数：`temperature: 0.3`（翻译偏确定性），`stream: true`。
- `model`：用 `/v1/models` 返回的第一个（或配置指定的）。

### 7.2 流式回写

- 后端解析 OpenAI SSE chunk 的 `choices[0].delta.content`，逐段转发为前端 SSE `delta` 事件。
- 累积所有 delta 得到 `target_text`，`done` 时落库。

---

## 8. Mock LM Studio API（回归测试）

### 8.1 目标

- 让后端单测/集成测试不依赖真实 LM Studio 实例与模型。
- `LMStudioAdapter` 通过环境变量 `LMSTUDIO_BASE_URL`（默认 `http://127.0.0.1:1234`）切换到 Mock 服务。

### 8.2 Mock 服务规约

独立轻量 HTTP Mock（测试时由 Vitest 启动于随机端口），实现 LM Studio 的 **OpenAI 兼容子集**：

#### `GET /v1/models`
```json
{
  "data": [
    { "id": "mock-hy-mt2-30b-a3b", "object": "model" }
  ]
}
```

#### `POST /v1/chat/completions`（非流式）
- 请求：标准 OpenAI chat completions body。
- 响应：**确定性映射**，依据请求头 `X-Mock-Source-Lang: zh|en` 决定方向（显式指定，不做中文检测猜测，避免中英混合文本误判）。
  - `X-Mock-Source-Lang: zh` → 输出固定英文译文，形如 `ZH→EN:<原文的ascii-safe表示>` 或内置对照表。
  - `X-Mock-Source-Lang: en` → 输出固定中文译文。
  - 缺省该头时按 `messages` 中 system prompt 推断方向（解析 `from <lang> to` 中的源语言），仅作兜底。
- 目的不是翻译质量，而是**可断言**的稳定输出，供测试校验历史落库、流式拼接、合集归属。

#### `POST /v1/chat/completions`（流式，`stream: true`）
- 返回 `Content-Type: text/event-stream`。
- 将确定性译文切成若干 chunk，按 OpenAI 流式格式逐个发：
  ```
  data: {"choices":[{"delta":{"content":"片段1"}}]}

  data: {"choices":[{"delta":{"content":"片段2"}}]}

  data: [DONE]
  ```
- 支持测试用例注入"中途断流"场景（用于验证后端 `error` 事件）。

#### 错误注入
- Mock 支持通过请求头或 query（如 `?mock_fail=lmstudio_down`）返回 503，模拟 LM Studio 不可达，测试降级路径。

### 8.3 测试用例集（回归清单）

| 用例 | 覆盖 |
| --- | --- |
| 启动时 LM Studio 已在跑（Mock 起在前） | `startedByUs=false`，翻译可用 |
| 启动时 LM Studio 未跑（Mock 不起）+ 之后拉起 | 重试探测逻辑（可注入模拟） |
| 中→英流式翻译，校验 delta 拼接与 done 落库 | TranslationService + DB |
| 英→中流式翻译 | 反向方向 |
| 流式中途断流 | error 事件、不落库 |
| 合集 CRUD + 切换 active | CollectionService |
| 单条删除 / 批量删除（多选 ids） | batch-delete |
| 删除 active 合集后自动切到下一个 | active 回退逻辑 |
| 关闭服务、`startedByUs=true` | 调用关闭（Mock 进程可被 kill） |
| 关闭服务、`startedByUs=false` | 不自动关，返回 409，前端弹窗路径（接口层断言） |

> Mock 与测试均置于 `tests/`，与生产代码隔离；`LMSTUDIO_BASE_URL` 指向 Mock 端口即可全链路回归。

---

## 9. 前端关键交互

### 9.1 页面结构

- 左栏：合集列表（可新建、切换、重命名、删除）。
- 右栏：当前合集的翻译区——顶部输入框 + 方向切换 + "翻译"按钮；下方历史列表。
- 历史列表项：原文 / 译文 / 时间 / 删除勾选框；流式翻译时最新一条实时增长。

### 9.2 多选删除（Shift / Ctrl）

- 列表项前有 checkbox；点行也可选中。
- **Ctrl+点击**：切换该项选中态（非连续多选）。
- **Shift+点击**：从上一个选中项到当前项之间（含两端）全部选中（连续范围选择）。
- **全选/取消全选**：列表头部的 checkbox 切换当前页全选/取消全选；列表区聚焦时 `Ctrl+A` 等效全选当前页。
- 顶部出现"已选 N 条 / 批量删除"操作条。
- 删除前二次确认（原生 confirm 或轻量模态）。
- 实现参考：维护 `lastSelectedIndex`，Shift 时计算区间并合并入 `selectedIds` Set。

### 9.3 SSE 接收

- 前端用 `EventSource` 不适用（需 POST）。改用 `fetch` + `ReadableStream` 解析 `text/event-stream`，或引入轻量 `@microsoft/fetch-event-source`。
- delta 实时追加到"正在翻译"行的译文区；done 后固化并刷入历史列表顶部。

### 9.4 并发控制

- **同一合集同一时刻只允许一个翻译请求在飞**：前端在翻译进行中禁用"翻译"按钮与方向切换，新点击入队或被忽略（实现选择，默认忽略）。
- 后端 `/api/translate/stream` 对同一 `collection_id` 检测到已有在飞请求时返回 `409 { error: "TRANSLATION_IN_FLIGHT" }`。
- 不同合集可并发（用户切到另一合集发起翻译不阻塞前一个），但 SSE 连接总数应有上限（实现取 `MAX_CONCURRENT_STREAMS`，默认 4；超出时返回 `409 TRANSLATION_IN_FLIGHT`）。
- 流式中途客户端断开：后端检测到连接关闭应取消上游 LM Studio 请求（abort），不落库——符合 §5.3"只在 done 时写入"。

---

## 10. 目录结构

> 下面是**实际实现**的结构（与初稿的差异：`server.ts` 拆成 `bootstrap.ts` + `http/app.ts`，
> 新增 `shutdown.ts`、`http/`、`packages/contracts`，前端产物输出到 `apps/server/public`）。

```
offline-translation-service/
├─ apps/
│  ├─ server/                   # 后端
│  │  ├─ src/
│  │  │  ├─ index.ts            # 进程入口：直跑判定 + 信号注册
│  │  │  ├─ bootstrap.ts        # 装配：DB init → LMStudio 启动 → HTTP listen
│  │  │  ├─ config.ts           # 端口、base url、超时等（§11）
│  │  │  ├─ shutdown.ts         # §3.4 两条关闭路径的编排
│  │  │  ├─ errors.ts           # HttpError 与错误码
│  │  │  ├─ http/               # app.ts（Express 装配）、parse.ts、asyncHandler.ts
│  │  │  ├─ routes/             # collections / entries / translate / lmstudio / shutdown
│  │  │  ├─ services/           # collectionService, translationService
│  │  │  ├─ lmstudio/           # adapter / process / locate / winProcess
│  │  │  └─ db/                 # index.ts（schema/迁移）、sqlite.ts（node:sqlite 适配）
│  │  ├─ public/                # 前端构建产物（gitignore，由 vite build 生成）
│  │  └─ data/                  # translations.db（gitignore）
│  └─ web/                      # 前端 Vite + React
│     ├─ src/
│     │  ├─ main.tsx / App.tsx / styles.css / format.ts
│     │  ├─ components/         # CollectionList, Translator, HistoryList, StatusBar, ConfirmDialog
│     │  ├─ hooks/              # useCollections, useEntries, useMultiSelect, useLmStudioStatus, useTranslator
│     │  └─ api/                # client.ts（fetch 封装）、translate.ts（POST SSE 解析）
│     └─ index.html
├─ packages/contracts/          # 共享契约类型（client/server）
├─ tests/
│  ├─ mock-lmstudio/            # Mock OpenAI 兼容服务（含故障注入）
│  ├─ helpers/                  # 测试装配、HTTP/SSE 断言、scratch 路径
│  ├─ unit/                     # 服务与 adapter 单测
│  └─ server/                   # 后端集成测试
├─ docs/                        # 使用指南与实现笔记（见 AGENTS.md 的文档边界）
├─ DESIGN.md                    # 本文档
├─ AGENTS.md                    # 实现指引（由实现 agent 维护）
└─ package.json                 # pnpm workspace 根
```

---

## 11. 配置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `5174` | 后端 HTTP 端口（避开 Vite 5173） |
| `HOST` | `127.0.0.1` | 监听地址；本服务无鉴权，**不得**改成对外地址（§1.3） |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234` | 推理端点；测试时指向 Mock |
| `LMSTUDIO_EXE` | （空，自动定位） | 覆盖 `lms.exe` / `LM Studio.exe` 路径 |
| `LMSTUDIO_MODEL` | （空，取首个） | 指定 model id |
| `LMSTUDIO_AUTOSTART` | `true` | 是否允许自动拉起 LM Studio（测试置 `false`） |
| `LMSTUDIO_START_ARGS` | `server start` | spawn 时使用的参数（实测校准，见 §6.3） |
| `DB_PATH` | `apps/server/data/translations.db` | SQLite 文件 |
| `LMSTUDIO_STARTUP_TIMEOUT_MS` | `120000` | 启动探测总超时（设计初稿为 60s，实测上调以覆盖冷启动；模型冷加载另见 `LMSTUDIO_WARMUP`） |
| `LMSTUDIO_PROBE_INTERVAL_MS` | `1000` | 探测初始间隔；超过 10 次后指数退避至 3000ms |
| `LMSTUDIO_PROBE_TIMEOUT_MS` | `2000` | 单次探测超时 |
| `LMSTUDIO_WARMUP` | `true` | 端点就绪后是否显式预加载模型（§13 第 5 条） |
| `LMSTUDIO_LOAD_TIMEOUT_MS` | `300000` | 显式加载模型允许的耗时（30B MoE 冷加载可达分钟级） |
| `LMSTUDIO_SHOW_CONSOLE` | `false` | spawn lmstudio.exe 时是否显示 console 窗口（调试用） |
| `TRANSLATE_MAX_CHARS` | `10000` | 单次翻译原文最大字符数，超出返回 `400 { error: "INPUT_TOO_LONG" }` |
| `MAX_CONCURRENT_STREAMS` | `4` | SSE 并发连接上限（§9.4） |
| `LMSTUDIO_MOCK_HEADERS` | `false` | **仅测试**：向上游附加 `X-Mock-Source-Lang`，让 Mock 方向判定确定（§8.2） |
| `OTS_TEST_MOCK_QUERY` | （空） | **仅测试**：向上游 chat/completions 附加 query，如 `mock_fail=mid_stream_cut`（§8.2 错误注入） |
| `OTS_TEST_MOCK_HEADERS` | （空） | **仅测试**：向上游请求附加头（`k=v&k2=v2`） |

---

## 12. 实现里程碑（M1–M7 均已完成）

1. **M1 骨架**：DB schema + CollectionService + 基础 REST + 前端合集切换。✅
2. **M2 翻译**：LMStudioAdapter + `/api/translate/stream` + 前端译文展示。✅
3. **M3 流式**：SSE 双端打通（前端手写 `fetch` + `ReadableStream` 解析）。✅
4. **M4 历史与多选删除**：entries CRUD + Shift/Ctrl 多选 + 批量删除 + 清空合集。✅
5. **M5 LM Studio 生命周期**：启动探测、spawn + PID、关闭归属判定、前端确认弹窗、模型预热。✅
6. **M6 Mock + 回归测试**：Mock 服务（含故障注入）+ §8.3 全部用例（96 个测试，`pnpm test`）。✅
7. **M7 打磨**：错误态 / 空态 / 加载态 UI、二次确认、服务已关闭横幅。✅

已核实的实现细节记在 `docs/impl-notes/`，使用说明见 `docs/usage.md`。

---

## 13. 开放项与实测结论

1. ~~LM Studio 桌面版是否支持 `server start` 子命令~~ → **已实测**：桌面版 `LM Studio.exe` 不支持；
   官方 CLI 是 `%USERPROFILE%\.lmstudio\bin\lms.exe`，用 `lms server start`；桌面版主程序仅作兜底。
   已写入 §6.2 / §6.3。
2. ~~注册表中 LM Studio 的确切键值~~ → **已实测**：本机 `HKCU\Software\LM Studio`、
   `HKCU\Software\LMStudio`、`HKLM\Software\LM Studio` 均不存在；注册表查询保留为最后的兜底，
   正常路径由 `LMSTUDIO_EXE` / `lms` CLI / 默认安装路径覆盖。
3. ~~是否引入 `@microsoft/fetch-event-source`~~ → **决定手写**：前端用 `fetch` + `ReadableStream`
   自行解析 `text/event-stream`（`apps/web/src/api/translate.ts`），不引入额外依赖。
4. ~~前端是否引入轻量 UI 库~~ → **决定不引入**：原生 CSS（`apps/web/src/styles.css`），
   多选语义（§9.2）由 `useMultiSelect` 自己实现。
5. ~~模型加载态感知~~ → **已验证并实现**：`GET /api/v0/models` 会返回每个模型的
   `state: "loaded" | "not-loaded"`；模型未驻留时首次推理会触发隐式加载。因此在端点
   就绪后追加一次 `POST /api/v1/models/load`（`LMSTUDIO_WARMUP=true`，独立超时
   `LMSTUDIO_LOAD_TIMEOUT_MS`），不阻塞 HTTP 启动；失败只记日志、不影响服务可用性。
   **重要实测**：该 load 端点每次成功调用都会**新建一个模型实例**（`model`、`model:2`…），
   即使模型已驻留；推理接口（`/v1/chat/completions`）则只复用已有实例。因此预热前必须
   先检查 `state`，已驻留就完全跳过，否则会把显存/内存吃光到无法再加载（本机实测出现
   `model_load_failed: insufficient system resources`）。
6. **大文本处理**：超过 `TRANSLATE_MAX_CHARS` 时目前直接拒绝。是否在后续版本支持分片翻译（按段落切分、并发或顺序、合并落库）——暂列为后续增强，不在 M1–M7 范围。
7. **历史搜索/过滤**：§5.2 仅分页，未提供按原文/译文关键词搜索。是否在 M7 或后续版本加入 `?q=keyword` 搜索——暂列为后续增强。

> 第 6、7 条是明确的后续增强，非当前 MVP 范围（§1.3 已限定非目标之外的功能需用户提出）。实现 agent 不应在 M1–M7 中实现它们。

---

## 附录 A：关键接口 TS 草签

```ts
// LMStudioAdapter
interface LMStudioAdapter {
  listModels(): Promise<string[]>;
  chatCompletion(req: {
    model?: string;
    messages: { role: 'system'|'user'; content: string }[];
    temperature?: number;
    stream: true;
  }): AsyncIterable<{ delta: string }>;   // 流式
  isReachable(): Promise<boolean>;
}

// LMStudioProcessManager
interface LMStudioProcessManager {
  startup(): Promise<{ running: boolean; startedByUs: boolean; pid?: number }>;
  shutdown(opts: { force?: boolean }): Promise<{ ok: boolean }>;
  status(): { running: boolean; startedByUs: boolean; pid?: number };
}

// CollectionService
interface CollectionService {
  list(): Collection[];
  create(name?: string): Collection;
  getActive(): Collection;
  setActive(id: string): Collection;
  rename(id: string, name: string): Collection;
  delete(id: string): void;
  listEntries(collectionId: string, page: number, pageSize: number): { items: Entry[]; total: number };
  deleteEntry(id: string): void;
  batchDeleteEntries(ids: string[]): number;
  clearEntries(collectionId: string): number;
}

// TranslationService
interface TranslationService {
  translateStream(req: {
    collection_id: string;
    source_lang: 'zh'|'en';
    target_lang: 'zh'|'en';
    source_text: string;
  }): AsyncIterable<
    | { type: 'delta'; text: string }
    | { type: 'done'; entry_id: string; target_text: string; model_id: string }
    | { type: 'error'; code: string; message: string }
  >;
}
```
