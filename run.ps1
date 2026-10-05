<#
.SYNOPSIS
  离线翻译服务一键启动（Windows / PowerShell）。

.DESCRIPTION
  依次完成：环境自检 → 必要时安装依赖 → 必要时构建 → 检查 LM Studio →
  启动后端（独立窗口）→ 等待就绪 → 打开浏览器。

  双击或右键"使用 PowerShell 运行"即可；也可以在终端里执行：
      pwsh -File run.ps1
      .\run.ps1 -Port 5175 -NoBrowser

.PARAMETER Port
  后端端口，默认 5174。

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

# ---------------------------------------------------------------- 4. LM Studio
# 只做探测与报告，不负责启动：LM Studio 的启动归后端所有
# （DESIGN.md §6.3/§6.4，2026-10-05 决定）。后端在端点不可达时会自行执行
# `lms server start`，该命令对冷机器同样有效，因此这里不重复启动。
Write-Step '检查 LM Studio（http://127.0.0.1:1234）'
$lmReady = $false
try {
  $lm = Invoke-WebRequest -Uri 'http://127.0.0.1:1234/v1/models' -UseBasicParsing -TimeoutSec 3
  $lmReady = $lm.StatusCode -eq 200
} catch {
  $lmReady = $false
}

if ($lmReady) {
  $models = @()
  try {
    $parsed = (Invoke-WebRequest -Uri 'http://127.0.0.1:1234/api/v0/models' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    $models = @($parsed.data | Where-Object { $_.state -eq 'loaded' } | Select-Object -ExpandProperty id)
  } catch {
    $models = @()
  }
  if ($models.Count -gt 0) {
    Write-Ok "已就绪，已加载模型：$($models -join ', ')"
  } else {
    Write-Warn2 '服务在运行，但当前没有已加载的模型；首次翻译会自动加载（可能较慢）'
  }
  Write-Note '关闭服务时只会卸载模型以释放内存，LM Studio 服务器会继续运行'
} else {
  Write-Warn2 '未检测到 LM Studio 本地服务器；后端启动时会自动拉起它'
  Write-Note '若长时间仍未就绪，请在 LM Studio 里打开本地服务器，并在界面上点"重试"'
}

# ---------------------------------------------------------------- 5. 启动后端
Write-Step '启动后端（独立窗口；在界面点「关闭服务」可卸载模型并正常退出）'
$env:PORT = "$Port"
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
