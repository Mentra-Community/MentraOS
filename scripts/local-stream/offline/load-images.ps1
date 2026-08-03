# load-images.ps1 - Load offline MediaMTX image into Docker (no registry pull).
# Tags the loaded image as bluenviron/mediamtx:1 for docker-compose.yml.
#
# NOTE: With $ErrorActionPreference=Stop, a missing image on `docker inspect`
# becomes a terminating NativeCommandError (stderr). Always probe via cmd.exe
# so "No such image" is a normal miss, not a script crash.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$OfflineDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ImagesDir = Join-Path $OfflineDir "images"
$ComposeImage = "bluenviron/mediamtx:1"

function Test-DockerAvailable {
  $out = cmd.exe /c "docker version --format {{.Server.Version}} 2>nul"
  return ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($out))
}

function Test-DockerImage {
  param([string]$Name)
  cmd.exe /c "docker image inspect `"$Name`" >nul 2>nul"
  return ($LASTEXITCODE -eq 0)
}

function Get-DockerImageId {
  param([string]$Name)
  $id = cmd.exe /c "docker image inspect `"$Name`" --format {{.Id}} 2>nul"
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($id)) {
    return $id.Trim()
  }
  return $null
}

function Get-PreferredTar {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ([string]::IsNullOrWhiteSpace($arch)) {
    $arch = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
  }
  $amd = Join-Path $ImagesDir "mediamtx-1-linux-amd64.tar"
  $arm = Join-Path $ImagesDir "mediamtx-1-linux-arm64.tar"

  Write-Host ("Host PROCESSOR_ARCHITECTURE={0}" -f $arch)
  Write-Host ("Offline images dir: {0}" -f $ImagesDir)

  if (-not (Test-Path -LiteralPath $ImagesDir)) {
    Write-Host "WARN: images folder missing."
    return $null
  }

  Get-ChildItem -LiteralPath $ImagesDir -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ("  found: {0} ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }

  if ($arch -match '(?i)ARM64|AARCH64') {
    if (Test-Path -LiteralPath $arm) { return $arm }
    if (Test-Path -LiteralPath $amd) {
      Write-Host "WARN: no arm64 tar; falling back to amd64 (may need emulation)."
      return $amd
    }
  } else {
    if (Test-Path -LiteralPath $amd) { return $amd }
    if (Test-Path -LiteralPath $arm) {
      Write-Host "WARN: no amd64 tar; falling back to arm64 (likely will not run)."
      return $arm
    }
  }
  return $null
}

if (-not (Test-DockerAvailable)) {
  Write-Host "ERROR: Docker engine not running. Start Docker Desktop, then retry."
  exit 1
}

# Already have the compose tag?
$existing = Get-DockerImageId -Name $ComposeImage
if ($null -ne $existing) {
  Write-Host ("Offline load skipped: {0} already present ({1})" -f $ComposeImage, $existing)
  exit 0
}

Write-Host ("{0} not present locally — loading from USB/offline tar..." -f $ComposeImage)

$tar = Get-PreferredTar
if ([string]::IsNullOrWhiteSpace($tar)) {
  Write-Host ("ERROR: No offline image tarballs in {0}" -f $ImagesDir)
  Write-Host "Expected mediamtx-1-linux-amd64.tar (Windows) or mediamtx-1-linux-arm64.tar"
  exit 1
}

Write-Host ("Loading offline image from {0} ..." -f $tar)
cmd.exe /c "docker load -i `"$tar`""
if ($LASTEXITCODE -ne 0) {
  Write-Host ("ERROR: docker load failed (exit {0})" -f $LASTEXITCODE)
  exit $LASTEXITCODE
}

# Compose expects bluenviron/mediamtx:1
$loadedTags = @(cmd.exe /c "docker images bluenviron/mediamtx --format {{.Repository}}:{{.Tag}} 2>nul")
Write-Host "Loaded tags:"
foreach ($t in $loadedTags) {
  if (-not [string]::IsNullOrWhiteSpace($t)) { Write-Host ("  {0}" -f $t) }
}

if (Test-DockerImage -Name $ComposeImage) {
  Write-Host ("Ready: {0}" -f $ComposeImage)
  exit 0
}

$candidates = @(
  "bluenviron/mediamtx:1-amd64",
  "bluenviron/mediamtx:1-arm64",
  "bluenviron/mediamtx:latest"
)
$source = $null
foreach ($c in $candidates) {
  if (Test-DockerImage -Name $c) { $source = $c; break }
}
if ($null -eq $source) {
  foreach ($t in $loadedTags) {
    if ($t -match '^bluenviron/mediamtx:' -and $t -notmatch '<none>') {
      $source = $t.Trim()
      break
    }
  }
}
if ($null -eq $source) {
  Write-Host "ERROR: Loaded image but could not find a tag to retag as bluenviron/mediamtx:1"
  exit 1
}

Write-Host ("Tagging {0} -> {1}" -f $source, $ComposeImage)
cmd.exe /c "docker tag `"$source`" `"$ComposeImage`""
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: docker tag failed"
  exit $LASTEXITCODE
}

Write-Host ("Ready: {0}" -f $ComposeImage)
exit 0
