<#
.SYNOPSIS
  程序化关闭离线翻译服务（Windows / PowerShell）。

.DESCRIPTION
  为「由其它项目调度本服务」的场景准备的**薄封装**：脚本本身不含任何清理逻辑，
  只做两件事——

    1. POST /api/shutdown  请求后端停机；
    2. 轮询 GET /api/collections 直到连接被拒，确认进程真的退出。

  为什么必须轮询：POST /api/shutdown 的响应**只表示"已受理"**。响应发出之后，
  后端才依次执行「卸载模型（实测约 2.4s）→ 停止接受新连接 → 关 DB → 退出」。
  若在收到响应后立刻去动那个终端窗口或进程，会把正在进行的卸载砍掉，
  模型将继续驻留内存，停机也就没有意义了。

  本脚本**不会终止任何进程**：后端窗口会随 node 进程退出而自动关闭
  （见 DESIGN.md §3.4-C 与 AGENTS.md 的启动脚本规则）。

.PARAMETER Port
  后端端口，默认 5174（需与启动时一致）。

.PARAMETER TimeoutSec
  等待后端真正退出的秒数，默认 60。停机含模型卸载，实测约 3s；
  留足余量以覆盖 30B 模型偶发变慢。超时按失败处理并返回非零退出码。

.EXAMPLE
  pwsh -File shutdown.ps1
  关闭默认端口 5174 上的服务；服务未运行则直接成功返回（幂等）。

.EXAMPLE
  pwsh -File shutdown.ps1 -Port 5175 -TimeoutSec 120
  关闭非默认端口，并给更长等待时间。
#>
[CmdletBinding()]
param(
  [int]$Port = 5174,
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$baseUrl = "http://127.0.0.1:$Port"

function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok([string]$message) { Write-Host "    $message" -ForegroundColor Green }
function Write-Note([string]$message) { Write-Host "    $message" -ForegroundColor DarkGray }
function Write-Warn2([string]$message) { Write-Host "    $message" -ForegroundColor Yellow }

function Fail([string]$message, [string[]]$hints = @()) {
  Write-Host ''
  Write-Host "关闭失败：$message" -ForegroundColor Red
  foreach ($hint in $hints) { Write-Host "  - $hint" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

# 后端是否仍在响应。停机过程中它会一直响应到真正退出，因此这个探针
# 同时充当「停机是否完成」的判据。
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
Write-Host '离线翻译服务 —— 关闭' -ForegroundColor White
Write-Host ''

# ---------------------------------------------------------------- 1. 幂等检查
if (-not (Test-Service $Port)) {
  Write-Step "检查端口 $Port"
  Write-Note '服务未在运行，无需关闭'
  Write-Host ''
  exit 0
}
Write-Step "检查端口 $Port"
Write-Ok '服务正在运行'

# ---------------------------------------------------------------- 2. 请求停机
Write-Step '请求后端停机（卸载模型 → 关数据库 → 退出）'
try {
  $response = Invoke-WebRequest -Uri "$baseUrl/api/shutdown" -Method POST `
    -UseBasicParsing -TimeoutSec 10
  if ($response.StatusCode -ne 200) {
    Fail "后端返回 HTTP $($response.StatusCode)" @(
      '若返回 400，请确认没有向该端点传任何请求体（closeLmStudio 参数已移除）'
    )
  }
} catch {
  Fail "无法调用 POST /api/shutdown：$($_.Exception.Message)" @(
    '确认服务是否仍在运行，以及端口号是否正确'
  )
}
Write-Ok '已受理（停机仍在进行中）'

# ---------------------------------------------------------------- 3. 等待真正退出
Write-Step "等待后端退出（最多 $TimeoutSec 秒）"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  if (-not (Test-Service $Port)) {
    Write-Ok '服务已退出'
    Write-Host ''
    Write-Host "提示：LM Studio 服务器仍在运行（这是设计如此）。" -ForegroundColor DarkGray
    Write-Host '      模型已卸载并释放内存；下次翻译会自动重新加载。' -ForegroundColor DarkGray
    Write-Host ''
    exit 0
  }
}

Fail "等待后端退出超时（$TimeoutSec 秒）" @(
  '模型卸载可能比预期慢，可加大 -TimeoutSec 重试',
  '若后端窗口里还有报错信息，请查看那里的输出'
)