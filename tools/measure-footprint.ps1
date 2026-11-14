<#
.SYNOPSIS
  Memory and disk footprint of a fake-mice Sidearm build (no real mouse, no real data).

.DESCRIPTION
  Copies the exe into a temp folder with the portable marker (so its data, and the
  WebView2 profile, live in <temp>\data), starts it with an empty virtual-mice folder
  (SIDEARM_FAKE_MICE), and measures sidearm.exe plus its msedgewebview2 processes
  (matched by the data folder in their command line): working set and private bytes,
  window hidden (a fake run keeps it hidden), shown (-Show, without activation) and
  hidden again. Quits through the fake build's quit file, then lists the WebView2
  profile's biggest folders. -Runs 2 starts the same folder twice (what a second
  start does with the first one's profile).

  Fake-mice builds only: a real build would take the real mice. Build one with
    cargo tauri build --no-bundle --features fake-mice
  (CARGO_TARGET_DIR=<target>\e2e keeps it apart from the real release build).

.EXAMPLE
  pwsh -File tools\measure-footprint.ps1 -Exe E:\Scripts\Sidearm\app\src-tauri\target\e2e\release\sidearm.exe -Show
#>
param(
  [Parameter(Mandatory)] [string]$Exe,
  [int]$Seconds = 60,
  [switch]$Show,
  [int]$Runs = 1,
  [string]$Root
)
$ErrorActionPreference = 'Stop'

$Exe = (Resolve-Path -LiteralPath $Exe).Path
# SIDEARM_FAKE_POPUPS is only read by a build with the `fake-mice` feature
# (SIDEARM_FAKE_MICE is in every build: the mutex scoping reads it).
if (-not [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($Exe)).Contains('SIDEARM_FAKE_POPUPS')) {
  throw "$Exe is not a fake-mice build: it would drive the real mice."
}

Add-Type -Namespace Footprint -Name Win -MemberDefinition @'
  public delegate bool EnumProc(System.IntPtr hwnd, System.IntPtr lparam);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, System.IntPtr lparam);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hwnd, out uint pid);
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hwnd, System.Text.StringBuilder text, int max);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hwnd, int cmd);
'@

function Find-MainWindow([int]$ProcessId) {
  $script:found = [IntPtr]::Zero
  [Footprint.Win]::EnumWindows({
      param($hwnd, $lparam)
      $owner = [uint32]0
      [void][Footprint.Win]::GetWindowThreadProcessId($hwnd, [ref]$owner)
      $title = [Text.StringBuilder]::new(64)
      [void][Footprint.Win]::GetWindowText($hwnd, $title, 64)
      if ($owner -eq $ProcessId -and $title.ToString() -eq 'Sidearm') { $script:found = $hwnd; return $false }
      return $true
    }, [IntPtr]::Zero) | Out-Null
  $script:found
}

function Measure-Processes([string]$Label, [string]$Data, [string]$AppExe) {
  $needle = "$Data\EBWebView"
  $rows = foreach ($p in Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='sidearm.exe'") {
    # The app and its helpers (capture helper, watchdog) run from the copied exe.
    $ours = if ($p.Name -eq 'sidearm.exe') { $p.ExecutablePath -eq $AppExe } else { $p.CommandLine -like "*$needle*" }
    if (-not $ours) { continue }
    $live = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if (-not $live) { continue }
    $kind = if ($p.Name -eq 'sidearm.exe') { 'app' } elseif ($p.CommandLine -match '--type=(\S+)') { $Matches[1] } else { 'browser' }
    [pscustomobject]@{ Kind = $kind; WS = $live.WorkingSet64; Private = $live.PrivateMemorySize64 }
  }
  $web = @($rows | Where-Object Kind -ne 'app')
  $app = @($rows | Where-Object Kind -eq 'app')
  $mb = { param($bytes) [math]::Round($bytes / 1MB, 1) }
  [pscustomobject]@{
    State          = $Label
    'Sidearm WS MB'    = & $mb ($app | Measure-Object WS -Sum).Sum
    'Sidearm Priv MB'  = & $mb ($app | Measure-Object Private -Sum).Sum
    'WebView procs' = $web.Count
    'WebView WS MB' = & $mb ($web | Measure-Object WS -Sum).Sum
    'WebView Priv MB' = & $mb ($web | Measure-Object Private -Sum).Sum
    'Total WS MB'  = & $mb ($rows | Measure-Object WS -Sum).Sum
    'Total Priv MB' = & $mb ($rows | Measure-Object Private -Sum).Sum
    'Biggest renderer WS MB' = & $mb (($web | Where-Object Kind -eq 'renderer' | Measure-Object WS -Maximum).Maximum)
  }
}

function Get-FolderSize([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  [long](Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
}

function Show-Profile([string]$Data) {
  # WebView2 keeps its Chromium profile in an EBWebView folder inside the user data folder.
  $profile = Join-Path $Data 'EBWebView\EBWebView'
  "EBWebView total: {0:N1} MB" -f ((Get-FolderSize (Join-Path $Data 'EBWebView')) / 1MB)
  $folders = @(Get-ChildItem -LiteralPath $profile -Directory -Force -ErrorAction SilentlyContinue) +
    @(Get-ChildItem -LiteralPath (Join-Path $profile 'Default') -Directory -Force -ErrorAction SilentlyContinue)
  $folders | ForEach-Object {
    [pscustomobject]@{ Folder = $_.FullName.Substring($profile.Length + 1); MB = [math]::Round((Get-FolderSize $_.FullName) / 1MB, 2) }
  } | Where-Object MB -gt 0.5 | Sort-Object MB -Descending | Select-Object -First 10 | Format-Table -AutoSize | Out-String
}

if (-not $Root) { $Root = Join-Path ([IO.Path]::GetTempPath()) ("sidearm-footprint-" + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$mice = Join-Path $Root 'mice'
$data = Join-Path $Root 'data'
New-Item -ItemType Directory -Force -Path $mice | Out-Null
$copy = Join-Path $Root 'sidearm.exe'
Copy-Item -LiteralPath $Exe -Destination $copy -Force
New-Item -ItemType File -Force -Path (Join-Path $Root 'sidearm.portable') | Out-Null
"Folder: $Root"

$env:SIDEARM_FAKE_MICE = $mice
for ($run = 1; $run -le $Runs; $run++) {
  Remove-Item -LiteralPath (Join-Path $mice 'quit') -Force -ErrorAction SilentlyContinue
  "== run $run (profile before start: {0:N1} MB)" -f ((Get-FolderSize (Join-Path $data 'EBWebView')) / 1MB)
  $started = [Diagnostics.Stopwatch]::StartNew()
  $app = Start-Process -FilePath $copy -PassThru
  Start-Sleep -Seconds $Seconds
  $table = @(Measure-Processes 'hidden' $data $copy)
  if ($Show) {
    $hwnd = Find-MainWindow $app.Id
    if ($hwnd -ne [IntPtr]::Zero) {
      [void][Footprint.Win]::ShowWindow($hwnd, 4) # SW_SHOWNOACTIVATE: no focus taken
      Start-Sleep -Seconds 20
      $table += Measure-Processes 'shown' $data $copy
      [void][Footprint.Win]::ShowWindow($hwnd, 0) # SW_HIDE
      Start-Sleep -Seconds 30
      $table += Measure-Processes 'hidden again' $data $copy
    } else { 'Main window not found: no shown measurement.' }
  }
  $table | Format-Table -AutoSize | Out-String -Width 250
  New-Item -ItemType File -Force -Path (Join-Path $mice 'quit') | Out-Null
  if (-not $app.WaitForExit(60000)) { 'App did not quit in 60 s: stopped.'; Stop-Process -Id $app.Id -Force }
  # WebView2 helpers outlive the app a moment.
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object CommandLine -like "*$data\EBWebView*")) { Start-Sleep -Milliseconds 500 }
  "Run took {0:N0} s" -f $started.Elapsed.TotalSeconds
  Show-Profile $data
}
