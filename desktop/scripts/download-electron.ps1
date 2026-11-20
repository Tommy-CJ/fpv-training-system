$ErrorActionPreference = 'Stop'
$version = '44.4.3'
$fileName = "electron-v$version-win32-x64.zip"
$totalBytes = 158247567
$chunkCount = 152
$outputDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\electron-dist'))
[System.IO.Directory]::CreateDirectory($outputDir) | Out-Null
$url = "https://cdn.npmmirror.com/binaries/electron/$version/$fileName"
$curlConfig = Join-Path $outputDir 'ranges.curl'
$curlLines = @()

for ($index = 0; $index -lt $chunkCount; $index++) {
  $start = [int64][Math]::Floor($totalBytes * $index / $chunkCount)
  $end = [int64][Math]::Floor($totalBytes * ($index + 1) / $chunkCount) - 1
  $partPath = Join-Path $outputDir ("$fileName.part{0:D2}" -f $index)
  if ((Test-Path -LiteralPath $partPath) -and (Get-Item -LiteralPath $partPath).Length -eq ($end - $start + 1)) {
    continue
  }
  if ($curlLines.Count -gt 0) { $curlLines += 'next' }
  $curlLines += "url = `"$url`""
  $curlLines += "range = `"$start-$end`""
  $curlLines += "output = `"$($partPath.Replace('\', '/'))`""
}

if ($curlLines.Count -gt 0) {
  Set-Content -LiteralPath $curlConfig -Value $curlLines -Encoding ascii
  & curl.exe --parallel --parallel-immediate --parallel-max 16 --fail --silent --show-error --location --retry 3 --max-time 120 --config $curlConfig
  if ($LASTEXITCODE -ne 0) { throw "Electron parallel download failed with exit code $LASTEXITCODE" }
}

$zipPath = Join-Path $outputDir $fileName
$target = [System.IO.File]::Create($zipPath)
try {
  for ($index = 0; $index -lt $chunkCount; $index++) {
    $start = [int64][Math]::Floor($totalBytes * $index / $chunkCount)
    $end = [int64][Math]::Floor($totalBytes * ($index + 1) / $chunkCount) - 1
    $partPath = Join-Path $outputDir ("$fileName.part{0:D2}" -f $index)
    if ((Get-Item -LiteralPath $partPath).Length -ne ($end - $start + 1)) {
      throw "Incomplete Electron range: $partPath"
    }
    $source = [System.IO.File]::OpenRead($partPath)
    try { $source.CopyTo($target) } finally { $source.Dispose() }
  }
} finally {
  $target.Dispose()
}

$expectedHash = '790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b'
$actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  Remove-Item -LiteralPath $zipPath
  throw "Electron SHA-256 mismatch: $actualHash"
}
Write-Output "Verified $zipPath ($actualHash)"
