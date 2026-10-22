$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp'))
$expected = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp'))
if (-not [String]::Equals($tempRoot, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw '临时目录安全校验失败' }
if (-not (Test-Path -LiteralPath $tempRoot -PathType Container)) { exit 0 }
$allowed = '^(state-[0-9a-f-]+\.tmp|server-(stdout|stderr)\.log|debug-[A-Za-z0-9._-]+\.tmp|browser-test-[A-Za-z0-9._-]+\.(png|json|trace)|download-[A-Za-z0-9._-]+\.tmp)$'
$removed = 0
foreach ($item in Get-ChildItem -LiteralPath $tempRoot -Force) {
  $absolute = [System.IO.Path]::GetFullPath($item.FullName)
  if (-not $absolute.StartsWith($tempRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝清理临时目录之外的路径：$absolute" }
  if ($item.Name -eq '.gitkeep') { continue }
  if (-not $item.PSIsContainer -and $item.Name -match $allowed) { Remove-Item -LiteralPath $absolute -Force; $removed++ }
}
Write-Output "已清理 $removed 个 WinCodex 临时文件。运行状态、锁文件、凭据、业务日志和用户数据均不在清理范围内。"

