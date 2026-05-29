[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lines = Get-Content -LiteralPath 'E:\Scripts\Sidearm-Portable\data\logs\Sidearm.log'
$matches = $lines | Select-String -Pattern 'F23|action-code-hypershift-thumb-11|action-code-hypershift-thumb-07|TextSnippet sendText|Lightweight clipboard|paste_via_clipboard|chunked|сигнал .F23'
$tail = $matches | Select-Object -Last 80
foreach ($m in $tail) { Write-Output $m.Line }
