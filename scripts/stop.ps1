$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeFile = Join-Path $projectRoot '.tmp\server.json'
$webRuntimeFile = Join-Path $projectRoot '.tmp\web.json'
$edgeProfile = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp\edge-profile'))
$lockFile = Join-Path $projectRoot 'data\server.lock'
$serverEntry = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'apps\server\dist\index.js'))

function Get-ManagedEdgeProcesses {
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'"
  foreach ($process in $processes) {
    if (-not $process.CommandLine -or $process.CommandLine.IndexOf($edgeProfile, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $process
  }
}

function Get-ManagedServerProcesses {
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
  foreach ($process in $processes) {
    if (-not $process.CommandLine -or $process.CommandLine.IndexOf($serverEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    if (-not $process.ExecutablePath -or [System.IO.Path]::GetFileName($process.ExecutablePath) -ine 'node.exe') { continue }
    $process
  }
}

$webRuntime = $null
try { if (Test-Path -LiteralPath $webRuntimeFile) { $webRuntime = Get-Content -LiteralPath $webRuntimeFile -Raw | ConvertFrom-Json } } catch { }
$managedWebRuntime = $false
try {
  $recordedProfile = [System.IO.Path]::GetFullPath([string]$webRuntime.profileDir)
  $managedWebRuntime = [String]::Equals($recordedProfile, $edgeProfile, [StringComparison]::OrdinalIgnoreCase)
} catch { }

# The isolated profile belongs only to WinCodex. Close its app window normally,
# then force-exit only Edge processes carrying this exact profile path if needed.
$edgeProcesses = @()
if ($managedWebRuntime -and $webRuntime.pid) {
  try {
    $recordedEdge = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$webRuntime.pid)"
    if ($recordedEdge -and $recordedEdge.Name -eq 'msedge.exe' -and $recordedEdge.CommandLine -notmatch '(?i)--type=' -and $recordedEdge.CommandLine.IndexOf($edgeProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $edgeProcesses = @($recordedEdge)
    }
  } catch { }
}
if ($edgeProcesses.Count -eq 0) { $edgeProcesses = @(Get-ManagedEdgeProcesses) }
$edgeRoots = @($edgeProcesses | Where-Object { $_.CommandLine -notmatch '(?i)--type=' })
foreach ($edgeRoot in $edgeRoots) {
  $browserWindow = Get-Process -Id ([int]$edgeRoot.ProcessId) -ErrorAction SilentlyContinue
  if ($browserWindow -and $browserWindow.MainWindowHandle -ne 0) { $browserWindow.CloseMainWindow() | Out-Null }
}
for ($i = 0; $i -lt 6 -and $edgeProcesses.Count -gt 0; $i++) {
  $stillRunning = @($edgeProcesses | ForEach-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue })
  if ($stillRunning.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}
$remainingEdgePids = @()
if ($edgeProcesses.Count -gt 0) {
  $remainingEdgePids = @($edgeProcesses | ForEach-Object { if (Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue) { [int]$_.ProcessId } } | Sort-Object -Unique)
}
if ($remainingEdgePids.Count -gt 0) {
  Stop-Process -Id $remainingEdgePids -Force
  Start-Sleep -Milliseconds 300
}

$runtime = $null
$lock = $null
try { if (Test-Path -LiteralPath $runtimeFile) { $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json } } catch { }
try { if (Test-Path -LiteralPath $lockFile) { $lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json } } catch { }
$serverProcesses = @(Get-ManagedServerProcesses)
$serverPids = @($serverProcesses | ForEach-Object { [int]$_.ProcessId })
$serverPorts = @()
if ($runtime -and $runtime.port) { $serverPorts += [int]$runtime.port }
if (-not ($runtime -and $runtime.port)) {
  foreach ($serverProcess in $serverProcesses) {
    try {
      $connections = @(Get-NetTCPConnection -State Listen -OwningProcess ([int]$serverProcess.ProcessId) -ErrorAction Stop)
      $serverPorts += @($connections | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } | ForEach-Object { [int]$_.LocalPort })
    } catch { }
  }
}
$serverPorts = @($serverPorts | Where-Object { $_ -gt 0 -and $_ -le 65535 } | Sort-Object -Unique)

# Older launches opened WinCodex as a tab in the user's regular Edge profile.
# Close only a tab whose title identifies WinCodex and whose local port belongs
# to this project's recorded runtime or verified server process.
if ($serverPorts.Count -gt 0) {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $edgeWindows = @(Get-Process msedge | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($edgeWindow in $edgeWindows) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$edgeWindow.MainWindowHandle)
      $tabCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
      $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
      $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $addressBar = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
      if (-not $addressBar) { continue }
      $addressPattern = $addressBar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      $originallySelected = $null
      foreach ($tab in $tabs) {
        try {
          if ($tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $originallySelected = $tab; break }
        } catch { }
      }
      foreach ($tab in $tabs) {
        if ($tab.Current.Name -notmatch '(?i)\bWinCodex\b') { continue }
        $selection = $null
        try { $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern) } catch { continue }
        if (-not $selection.Current.IsSelected) { $selection.Select(); Start-Sleep -Milliseconds 150 }
        $address = [string]$addressPattern.Current.Value
        if ($address -notmatch '^[a-z][a-z0-9+.-]*://') { $address = "http://$address" }
        $uri = $null
        $isManagedAddress = [Uri]::TryCreate($address, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq 'http' -and $uri.Host -in @('127.0.0.1','localhost') -and $serverPorts -contains $uri.Port
        if ($isManagedAddress) {
          $closeButton = $walker.GetFirstChild($tab)
          while ($closeButton -and $closeButton.Current.ClassName -ne 'EdgeTabCloseButton') { $closeButton = $walker.GetNextSibling($closeButton) }
          if ($closeButton) { $closeButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
          $originallySelected = $null
          break
        }
      }
      if ($originallySelected) {
        try { $originallySelected.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { }
      }
    }
  } catch { }
}

if ($runtime -and $runtime.port -and $runtime.csrfToken -and $serverPids -contains [int]$runtime.pid) {
  $url = "http://127.0.0.1:$($runtime.port)"
  try {
    Invoke-RestMethod -Uri "$url/api/shutdown" -Method Post -Headers @{ 'X-WinCodex-CSRF' = [string]$runtime.csrfToken } -TimeoutSec 3 -UseBasicParsing | Out-Null
  } catch { }
}

for ($i = 0; $i -lt 8; $i++) {
  $stillRunning = @($serverPids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($stillRunning.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}
foreach ($serverPid in $serverPids) {
  $stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
  if ($stillRunning -and $stillRunning.Name -eq 'node.exe' -and $stillRunning.CommandLine.IndexOf($serverEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Stop-Process -Id $serverPid -Force
  }
}

$knownPids = @($serverPids)
if ($runtime -and $runtime.pid) { $knownPids += [int]$runtime.pid }
if ($lock -and $lock.pid) { $knownPids += [int]$lock.pid }
$knownPids = @($knownPids | Sort-Object -Unique)
if ($knownPids.Count -gt 0) {
  try {
    $runtimeNow = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    if ($knownPids -contains [int]$runtimeNow.pid) { Remove-Item -LiteralPath $runtimeFile -Force }
  } catch { }
  try {
    $lockNow = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
    if ($knownPids -contains [int]$lockNow.pid) { Remove-Item -LiteralPath $lockFile -Force }
  } catch { }
}

if ($managedWebRuntime) { Remove-Item -LiteralPath $webRuntimeFile -Force }
