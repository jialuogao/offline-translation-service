<#
.SYNOPSIS
  离线翻译服务一键启动（Windows / PowerShell）。

.DESCRIPTION
  依次完成：环境自检 → 必要时安装依赖 → 必要时构建 → 确保 LM Studio 服务器与
  模型就绪（自动 load，失败重试 3 次）→ 启动后端（独立窗口）→ 等待就绪 → 打开浏览器。

  双击或右键"使用 PowerShell 运行"即可；也可以在终端里执行：
      pwsh -File run.ps1
      .\run.ps1 -Port 5175 -NoBrowser

.PARAMETER Port
  后端端口，默认 5174。

.PARAMETER Model
  要加载的模型标识，**透传**给后端（设为 LMSTUDIO_MODEL 环境变量）。
  缺省时后端用自己的默认值（hy-mt2-30b-a3b-uncensored-v1-apex）。
  注意：本服务只认这一个模型（加载/卸载都以它为准），换模型请显式指定。

.PARAMETER NoBrowser
  不自动打开浏览器。

.PARAMETER SkipBuild
  跳过构建检查（源码没改时可省几秒）。

.PARAMETER ForceBuild
  无条件重新构建。

.EXAMPLE
  .\run.ps1
  最常用：直接用默认端口 5174 启动并打开界面。
#>
[CmdletBinding()]
param(
  [int]$Port = 5174,
  [string]$Model = '',
  [switch]$NoBrowser,
  [switch]$SkipBuild,
  [switch]$ForceBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = (Get-Location).Path }

$serviceEntry = Join-Path $root 'apps\server\dist\index.js'
$webIndex = Join-Path $root 'apps\server\public\index.html'
$installMarker = Join-Path $root 'node_modules\.modules.yaml'
$url = "http://127.0.0.1:$Port/"

# 模型由后端负责加载（§6.3：后端启动后运行"确保模型就绪"循环并写进
# /api/service/status）。`-Model` 参数只是**透传给后端**的 LMSTUDIO_MODEL
# 环境变量：显式指定时覆盖，未指定时沿用环境或后端的默认值（hy-...）。
# run.ps1 自身不 load、不重试、不直接探测 LM Studio。
if (-not [string]::IsNullOrWhiteSpace($Model)) {
  $env:LMSTUDIO_MODEL = $Model.Trim()
}

function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok([string]$message) { Write-Host "    $message" -ForegroundColor Green }
function Write-Note([string]$message) { Write-Host "    $message" -ForegroundColor DarkGray }
function Write-Warn2([string]$message) { Write-Host "    $message" -ForegroundColor Yellow }

function Fail([string]$message, [string[]]$hints = @()) {
  Write-Host ''
  Write-Host "启动失败：$message" -ForegroundColor Red
  foreach ($hint in $hints) { Write-Host "  - $hint" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

function Test-Service([int]$targetPort) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$targetPort/api/collections" `
      -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

<#
.SYNOPSIS
  把启动失败原因上报到 personal-util-server 门户（Service alerts 协议，§3.5）。

.DESCRIPTION
  协议：POST {token, message} 到 $env:PU_REPORT_URL。被门户（startScript）启动的
  脚本会拿到这两个环境变量；手动运行时不存在，此时只提示、不上报。

  门户使用自签 CA，需要忽略证书校验：pwsh 7 有 -SkipCertificateCheck，
  PowerShell 5.1 没有，故按版本分支（5.1 用 ServicePointManager 全局回调，
  try/finally 还原，避免影响脚本其余部分）。
#>
function Send-ServiceAlert([string]$message) {
  if ([string]::IsNullOrWhiteSpace($env:PU_REPORT_URL) -or
      [string]::IsNullOrWhiteSpace($env:PU_REPORT_TOKEN)) {
    Write-Note '（未配置 PU_REPORT_URL/PU_REPORT_TOKEN，跳过门户上报）'
    return
  }
  try {
    $body = @{ token = $env:PU_REPORT_TOKEN; message = $message } | ConvertTo-Json -Compress
    if ($PSVersionTable.PSVersion.Major -ge 6) {
      Invoke-RestMethod -Uri $env:PU_REPORT_URL -Method Post -ContentType 'application/json' `
        -Body $body -SkipCertificateCheck -TimeoutSec 5 | Out-Null
    } else {
      $previous = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
      try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        Invoke-RestMethod -Uri $env:PU_REPORT_URL -Method Post -ContentType 'application/json' `
          -Body $body -TimeoutSec 5 | Out-Null
      } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previous
      }
    }
    Write-Ok "已上报失败原因到门户：$message"
  } catch {
    Write-Warn2 "门户上报失败（不影响启动）：$($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host '离线翻译服务 —— 一键启动' -ForegroundColor White
Write-Host "仓库：$root"
Write-Host ''

# ---------------------------------------------------------------- 1. 环境自检
Write-Step '检查运行环境'

if ($PSVersionTable.PSVersion.Major -lt 5) {
  Fail "PowerShell 版本过低（$($PSVersionTable.PSVersion)）" @('需要 PowerShell 5.1 或更高版本')
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Fail '未找到 Node.js' @('请安装 Node.js 22.13 或更高版本：https://nodejs.org/')
}
$nodeVersion = (& node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
  Fail "Node.js 版本过低（v$nodeVersion）" @('本项目使用 Node 内置 node:sqlite，需要 Node 22.13 或更高版本')
}
Write-Ok "Node.js v$nodeVersion"

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($null -eq $pnpm) {
  Fail '未找到 pnpm' @('请安装 pnpm：npm install -g pnpm', '或使用 corepack enable pnpm')
}
Write-Ok "pnpm $(& pnpm --version)"

if (-not (Test-Path (Join-Path $root 'package.json'))) {
  Fail "当前目录不是本项目仓库（缺少 package.json）：$root"
}

# ---------------------------------------------------------------- 2. 依赖与构建
if (-not (Test-Path $installMarker)) {
  Write-Step '首次运行：安装依赖（可能需要几分钟，若报 ERR_PNPM_IGNORED_BUILDS 请按提示运行 pnpm approve-builds）'
  & pnpm install
  if ($LASTEXITCODE -ne 0) {
    Fail 'pnpm install 失败' @(
      '可尝试：pnpm install --trust-lockfile',
      '若提示 Ignored build scripts，先运行 pnpm approve-builds 放行 esbuild'
    )
  }
  Write-Ok '依赖安装完成'
} else {
  Write-Ok '依赖已安装'
}

if ($ForceBuild -or -not $SkipBuild) {
  $needsBuild = $ForceBuild -or (-not (Test-Path $serviceEntry)) -or (-not (Test-Path $webIndex))

  if (-not $needsBuild) {
    # 源码比构建产物新 → 重新构建。产物时间取两个入口里较早的那个。
    $built = (Get-Item $serviceEntry).LastWriteTime
    $web = (Get-Item $webIndex).LastWriteTime
    if ($web -lt $built) { $built = $web }
    $sources = Get-ChildItem -Path @(
      (Join-Path $root 'apps\server\src'),
      (Join-Path $root 'apps\web\src'),
      (Join-Path $root 'packages\contracts\src')
    ) -Recurse -File -Include *.ts, *.tsx, *.css, *.html -ErrorAction SilentlyContinue
    $newest = $sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -ne $newest -and $newest.LastWriteTime -gt $built) {
      $needsBuild = $true
      Write-Note "检测到源码更新（$($newest.Name)），需要重新构建"
    }
  }

  if ($needsBuild) {
    Write-Step '构建（共享契约 → 前端 → 后端）'
    & pnpm build
    if ($LASTEXITCODE -ne 0) { Fail 'pnpm build 失败' @('详见上方错误输出') }
    Write-Ok '构建完成'
  } else {
    Write-Ok '构建产物已是最新'
  }
}

# ---------------------------------------------------------------- 3. 端口占用
Write-Step "检查端口 $Port"
if (Test-Service $Port) {
  Write-Warn2 '该端口已经有本服务在运行'
  Write-Host ''
  Write-Host "界面地址：$url" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process $url | Out-Null }
  exit 0
}
try {
  $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
  if ($null -ne $busy) {
    Fail "端口 $Port 已被 PID $($busy[0].OwningProcess) 占用" @(
      "换个端口：.\run.ps1 -Port 5175",
      "或先确认占用者：netstat -ano -p tcp | findstr :$Port"
    )
  }
} catch {
  # Get-NetTCPConnection 在普通会话可能被拒绝；忽略，交给后面的启动报错兜底。
}
Write-Ok "端口 $Port 可用"

# ---------------------------------------------------------------- 4.（已移除）
# 旧版在这里直接探测 LM Studio 的 HTTP 端点。现在改为：后端启动后轮询其
# 统一反馈端点 `/api/service/status`（§5.4）——LM Studio 服务器拉起、模型加载、
# 数据库可用性都由后端负责并在该端点忠实汇报；run.ps1 只负责呈现结论。
# 这样避免了两处判断不一致（script 认为好了、后端认为没好）。

# ---------------------------------------------------------------- 5. 启动后端
Write-Step '启动后端（独立窗口；在界面点「关闭服务」可卸载模型并正常退出）'
$env:PORT = "$Port"
# 模型加载由后端负责（LMSTUDIO_MODEL，默认 hy-...）；run.ps1 不 load、
# 不做重试。后端启动后会在后台运行"确保模型就绪"循环，并把进度写进
# /api/service/status（§6.3）。
$server = Start-Process -FilePath 'pnpm.cmd' -ArgumentList @('start') -WorkingDirectory $root `
  -PassThru -WindowStyle Normal
if ($null -eq $server) { Fail '无法启动后端进程' }

Write-Note "PID $($server.Id)"

# ---------------------------------------------------------------- 6. 等待就绪
Write-Step '等待服务就绪'
$ready = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if ($server.HasExited) {
    Fail "后端进程已退出（退出码 $($server.ExitCode)）" @(
      '请查看后端窗口里的错误信息',
      '端口被占用时可换：.\run.ps1 -Port 5175'
    )
  }
  if (Test-Service $Port) { $ready = $true; break }
  Start-Sleep -Milliseconds 300
}

if (-not $ready) {
  Fail '等待服务就绪超时（90 秒）' @('请查看后端窗口的输出')
}
Write-Ok '服务已就绪'

# ---------------------------------------------------------------- 6.5 等待服务状态落定
# 统一反馈端点（DESIGN.md §5.4）：后端汇报 db / storage / lmstudio 三个模块的
# 状态（loading → ok / error）。这里轮询到**所有模块都不再 loading**（全部落定），
# 或 2 分钟超时；然后把失败模块的错误打印出来（被 personal-util-server 门户启动时，
# 还会按 §3.5 的 Service alerts 协议上报到 PU_REPORT_URL）。
# 无论模型是否加载成功都不阻塞打开界面：UI 的合集/历史等功能不依赖翻译。
Write-Step '等待各子系统状态落定（模型加载最多重试 3 次）'
$statusUrl = "http://127.0.0.1:$Port/api/service/status"
$statusDone = $false
$statusDeadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $statusDeadline) {
  $pending = $false
  try {
    $svc = (Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
    $pending = $svc.pending -eq $true
  } catch {
    $pending = $true   # 后端刚起，端点还没就绪：继续等
  }
  if (-not $pending) { $statusDone = $true; break }
  Start-Sleep -Seconds 2
}

if ($statusDone) {
  try {
    $svc = (Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
    if ($svc.ok -eq $true) {
      $loaded = $svc.modules.lmstudio.detail
      if ($loaded) { Write-Ok "LM Studio 与模型就绪：$loaded" }
      else { Write-Ok '全部子系统就绪' }
    } else {
      Write-Warn2 '部分子系统未就绪：'
      foreach ($err in $svc.errors) {
        Write-Warn2 "  - $($err.module)：$($err.message)"
      }
      Write-Warn2 '  （提示：若 LM Studio 反复加载失败，可能需要手动杀掉 LM Studio 进程后重试）'
      $alertMessage = ($svc.errors | ForEach-Object { "$($_.module)：$($_.message)" }) -join '；'
      Send-ServiceAlert "离线翻译服务启动异常：$alertMessage"
    }
  } catch {
    Write-Warn2 '无法读取服务状态（后端可能已退出），请查看后端窗口输出'
  }
} else {
  Write-Warn2 '等待服务状态落定超时（120 秒）；界面已可用，但模型可能尚未就绪'
  Write-Warn2 '  （提示：若 LM Studio 反复加载失败，可能需要手动杀掉 LM Studio 进程后重试）'
  Send-ServiceAlert '离线翻译服务启动超时（120 秒内子系统状态未落定）；模型可能未加载'
}

# ---------------------------------------------------------------- 7. 打开界面
if (-not $NoBrowser) {
  try {
    Start-Process $url | Out-Null
    Write-Ok '已打开浏览器'
  } catch {
    Write-Warn2 '无法自动打开浏览器，请手动访问下面的地址'
  }
}

Write-Host ''
Write-Host "界面地址：$url" -ForegroundColor Green
Write-Host '停止服务：关闭后端窗口，或在界面上点"关闭服务"' -ForegroundColor DarkGray
Write-Host ''
