$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$shortcutPath = Join-Path $projectRoot 'WinCodex.lnk'
$runtimeFile = Join-Path $projectRoot '.tmp\server.json'
$webRuntimeFile = Join-Path $projectRoot '.tmp\web.json'
$edgeProfile = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp\edge-profile'))
$lockFile = Join-Path $projectRoot 'data\server.lock'
$serverEntry = Join-Path $projectRoot 'apps\server\dist\index.js'
$url = $null

function Show-Problem([string]$Message) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($Message, 'WinCodex', 'OK', 'Error') | Out-Null
}

function Resolve-EdgePath {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe') }
  foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')) {
    try { $registered = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'; if ($registered) { $candidates += $registered } } catch { }
  }
  $command = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}

function Get-ManagedEdgeRoots {
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    if (-not $process.CommandLine -or $process.CommandLine.IndexOf($edgeProfile, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    if ($process.CommandLine -match '(?i)--type=') { continue }
    $live = Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
    if ($live) {
      [pscustomobject]@{
        ProcessId = [int]$process.ProcessId
        WindowHandle = [long]$live.MainWindowHandle
        WindowTitle = [string]$live.MainWindowTitle
      }
    }
  }
}

function Write-WebRuntime([int]$ProcessId) {
  $payload = [ordered]@{
    pid = $ProcessId
    profileDir = $edgeProfile
    url = $url
    appMode = $true
    startedAt = [DateTime]::UtcNow.ToString('o')
  }
  $temporaryFile = "$webRuntimeFile.tmp"
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
  Move-Item -LiteralPath $temporaryFile -Destination $webRuntimeFile -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.tmp') -PathType Container)) {
  New-Item -ItemType Directory -Path (Join-Path $projectRoot '.tmp') -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
  $shortcutScript = Join-Path $PSScriptRoot 'create-shortcut.ps1'
  try { & $shortcutScript | Out-Null } catch { }
}

$edge = Resolve-EdgePath
if (-not $edge) {
  Show-Problem '找不到 Microsoft Edge。请安装 Edge 后，再双击启动脚本。'
  exit 1
}

function Test-LocalService {
  if (-not (Test-Path -LiteralPath $runtimeFile)) { return $false }
  try {
    $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $candidate = "http://127.0.0.1:$($runtime.port)"
    $result = Invoke-RestMethod -Uri "$candidate/api/health" -TimeoutSec 2 -UseBasicParsing
    if ($result.ok -and $result.service -eq 'WinCodex') { $script:url = $candidate; return $true }
  } catch { }
  return $false
}

if (-not (Test-LocalService)) {
  if (Test-Path -LiteralPath $lockFile) {
    try {
      $lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
      $process = Get-Process -Id ([int]$lock.pid) -ErrorAction Stop
      for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-LocalService) { break }
        if ($process.HasExited) { break }
      }
      if (-not $url -and -not $process.HasExited) {
        Show-Problem '检测到 WinCodex 后端进程正在运行，但本地健康检查未通过。为避免启动第二个实例，请使用停止脚本后重试。'
        exit 1
      }
    } catch {
      Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not $url) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { Show-Problem '找不到 Node.js。请安装 Node.js 22.21 或 24.5 及更高版本后，再双击启动脚本。'; exit 1 }
  $versionParts = (& $nodeCommand.Source --version).TrimStart('v').Split('.')
  $nodeMajor = [int]$versionParts[0]
  $nodeMinor = [int]$versionParts[1]
  if (-not (($nodeMajor -eq 22 -and $nodeMinor -ge 21) -or ($nodeMajor -eq 24 -and $nodeMinor -ge 5) -or $nodeMajor -ge 25)) { Show-Problem 'WinCodex 的 Tunnel 代理支持要求 Node.js 22.21 或 24.5 及更高版本。'; exit 1 }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\fastify')) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\vite'))) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { Show-Problem '找不到 npm。请安装包含 npm 的 Node.js 22.21 或 24.5 及更高版本后重试。'; exit 1 }
    $install = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','npm install --no-audit --no-fund') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) { Show-Problem 'WinCodex 依赖安装失败。请检查网络连接和项目根目录中的 package-lock.json。'; exit 1 }
  }
  if (-not (Test-Path -LiteralPath $serverEntry) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'apps\web\dist\index.html'))) {
    $build = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','npm run build') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru
    if ($build.ExitCode -ne 0) { Show-Problem 'WinCodex 前端或后端尚未构建成功。请检查项目依赖，然后重试启动。'; exit 1 }
  }
  $outLog = Join-Path $projectRoot '.tmp\server-stdout.log'
  $errLog = Join-Path $projectRoot '.tmp\server-stderr.log'
  $proxyUrl = 'http://127.0.0.1:9910'
  $proxyEnvironment = @{
    HTTP_PROXY = [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process')
    HTTPS_PROXY = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'Process')
    NO_PROXY = [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process')
  }
  try {
    $env:HTTP_PROXY = $proxyUrl
    $env:HTTPS_PROXY = $proxyUrl
    $env:NO_PROXY = 'localhost,127.0.0.1,::1'
    Start-Process -FilePath $nodeCommand.Source -ArgumentList @('--use-env-proxy', "`"$serverEntry`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null
  } finally {
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
      [Environment]::SetEnvironmentVariable($name, $proxyEnvironment[$name], 'Process')
    }
  }
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-LocalService) { break }
  }
  if (-not $url) {
    $detail = ''
    if (Test-Path -LiteralPath $errLog) { $detail = (Get-Content -LiteralPath $errLog -Tail 8 -ErrorAction SilentlyContinue) -join "`n" }
    Show-Problem ("WinCodex 后端没有通过本机健康检查。" + [Environment]::NewLine + $detail)
    exit 1
  }
}

New-Item -ItemType Directory -Path $edgeProfile -Force | Out-Null
$existingWindow = Get-ManagedEdgeRoots | Where-Object { $_.WindowHandle -ne 0 } | Select-Object -First 1
if ($existingWindow) {
  try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinCodexWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
    [WinCodexWindow]::ShowWindowAsync([IntPtr]$existingWindow.WindowHandle, 9) | Out-Null
    [WinCodexWindow]::SetForegroundWindow([IntPtr]$existingWindow.WindowHandle) | Out-Null
  } catch { }
  Write-WebRuntime -ProcessId $existingWindow.ProcessId
  exit 0
}

$edgeArguments = @(
  "--user-data-dir=`"$edgeProfile`"",
  "--app=`"$url`"",
  '--no-first-run',
  '--no-default-browser-check'
)
try {
  Start-Process -FilePath $edge -ArgumentList $edgeArguments | Out-Null
} catch {
  Show-Problem ("无法启动 WinCodex 的 Edge 窗口。" + [Environment]::NewLine + $_.Exception.Message)
  exit 1
}

$managedWindow = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $managedWindow = Get-ManagedEdgeRoots | Where-Object { $_.WindowHandle -ne 0 } | Select-Object -First 1
  if ($managedWindow) { break }
}
if (-not $managedWindow) {
  Show-Problem 'WinCodex 服务已启动，但没有检测到 Edge 窗口。请检查 Edge 是否被安全软件或系统策略阻止。'
  exit 1
}
Write-WebRuntime -ProcessId $managedWindow.ProcessId
