param(
  [ValidateRange(1, 16)][int]$Receivers = 8,
  [ValidateRange(1, 60)][int]$RateHz = 30,
  [string]$RelayUrl = "wss://app.1.gzfpv.cn/live-ws"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$GeneratorScript = Join-Path $PSScriptRoot "virtual-receiver-array.mjs"
$node = (Get-Command node -ErrorAction Stop).Source

Write-Host "Virtual receiver array is starting:" -ForegroundColor Green
Write-Host "  1. Keep this window open"
Write-Host "  2. The training system must be running"
Write-Host "  3. Output: $Receivers receivers / $RateHz Hz"
Write-Host "  4. No virtual COM driver or administrator permission is required"
Write-Host "Press Ctrl+C to stop. Closing this window leaves no COM device behind."

Push-Location $RepoRoot
try {
  & $node $GeneratorScript --relay $RelayUrl --receivers $Receivers --rate $RateHz
} finally {
  Pop-Location
}
