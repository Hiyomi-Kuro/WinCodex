$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launchScript = Join-Path $projectRoot 'scripts\launch.ps1'
$shortcutPath = Join-Path $projectRoot 'WinCodex.lnk'
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $launchScript)) { throw 'WinCodex 启动脚本不存在。' }
if (-not (Test-Path -LiteralPath $powerShell)) { throw 'Windows PowerShell 5.1 不可用。' }
$edge = @(
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShell
$shortcut.Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launchScript`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = '启动 WinCodex 本机只读 MCP 文件服务并在 Edge 中打开界面'
if ($edge) { $shortcut.IconLocation = "$edge,0" }
else { $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',167' }
$shortcut.Save()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
if (-not (Test-Path -LiteralPath $shortcutPath) -or (Get-Item -LiteralPath $shortcutPath).Length -lt 500) { throw '快捷方式文件未正确生成。' }
$verify = New-Object -ComObject WScript.Shell
$resolved = $verify.CreateShortcut($shortcutPath)
if ($resolved.TargetPath -ne $powerShell -or $resolved.WorkingDirectory -ne $projectRoot -or $resolved.Arguments -notlike '*scripts\launch.ps1*') { throw '快捷方式目标、工作目录或参数校验失败。' }
Write-Output "已生成并校验真实 Windows 快捷方式：$shortcutPath"
Write-Output "目标：$($resolved.TargetPath)"
Write-Output "工作目录：$($resolved.WorkingDirectory)"
