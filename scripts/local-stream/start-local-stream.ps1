# start-local-stream.ps1 - Windows native starter for Mentra Live -> laptop MediaMTX.
# RTMP primary; SRT + WHIP/WHEP also available.
#
# Usage (PowerShell):
#   .\scripts\local-stream\start-local-stream.ps1
#   $env:LAN_IP = "192.168.43.81"; .\scripts\local-stream\start-local-stream.ps1
#
# Or double-click / cmd:
#   scripts\local-stream\start-local-stream.cmd
#
# Requires: Docker Desktop running on Windows.
# Ctrl+C stops the receive-stats monitor; MediaMTX keeps running.

[CmdletBinding()]
param(
  [string]$LanIp = "",
  [double]$PollSeconds = 1,
  [string]$MtxApi = "http://127.0.0.1:9997",
  [string]$PathNames = "live/stream,live"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptDir

function Test-IsPrivateIPv4 {
  param([string]$Ip)
  if ($Ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
  if ($Ip -eq "127.0.0.1") { return $false }
  # Skip typical WSL / Docker bridge ranges when a better Wi-Fi IP exists.
  if ($Ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') { return $false }
  if ($Ip -match '^169\.254\.') { return $false }
  return $true
}

function Get-LanIp {
  param([string]$Override)

  if (-not [string]::IsNullOrWhiteSpace($Override)) {
    return $Override.Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LAN_IP)) {
    return $env:LAN_IP.Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($env:MTX_WEBRTCADDITIONALHOSTS)) {
    return ($env:MTX_WEBRTCADDITIONALHOSTS -split ",")[0].Trim()
  }

  $candidates = @()

  try {
    $adapters = Get-NetIPConfiguration -ErrorAction Stop |
      Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq "Up" }

    foreach ($cfg in $adapters) {
      $name = [string]$cfg.InterfaceAlias
      $ip = [string]$cfg.IPv4Address.IPAddress
      if (-not (Test-IsPrivateIPv4 -Ip $ip)) { continue }

      $score = 0
      # Mentra Live / Android hotspot subnet - highest priority.
      if ($ip -match '^192\.168\.43\.') { $score += 100 }
      if ($name -match '(?i)wi-?fi|wireless|wlan') { $score += 50 }
      if ($ip -match '^192\.168\.') { $score += 20 }
      if ($ip -match '^10\.') { $score += 10 }
      if ($cfg.IPv4DefaultGateway) { $score += 15 }

      $candidates += [pscustomobject]@{ Ip = $ip; Score = $score; Name = $name }
    }
  } catch {
    # Fall through to ipconfig parse.
  }

  if ($candidates.Count -gt 0) {
    return ($candidates | Sort-Object -Property Score -Descending | Select-Object -First 1).Ip
  }

  $text = & ipconfig.exe 2>$null | Out-String
  $rxMatches = [regex]::Matches($text, 'IPv4 Address[.\s]*:\s*(\d+\.\d+\.\d+\.\d+)')
  $ips = @()
  foreach ($m in $rxMatches) {
    $ip = $m.Groups[1].Value
    if (Test-IsPrivateIPv4 -Ip $ip) { $ips += $ip }
  }

  $hotspot = $ips | Where-Object { $_ -match '^192\.168\.43\.' } | Select-Object -First 1
  if ($hotspot) { return $hotspot }
  $priv = $ips | Where-Object { $_ -match '^192\.168\.' } | Select-Object -First 1
  if ($priv) { return $priv }
  if ($ips.Count -gt 0) { return $ips[0] }

  return ""
}

function Test-DockerAvailable {
  try {
    $null = & docker version --format "{{.Server.Version}}" 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Monitor-ReceiveStats {
  param(
    [string]$Api,
    [string]$PathsCsv,
    [double]$Poll
  )

  $paths = @($PathsCsv -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  Write-Host "--------------------------------------------------------"
  Write-Host "RECEIVE STATS (from MediaMTX - what this laptop gets)"
  Write-Host ("  Paths: {0}" -f $PathsCsv)
  Write-Host ("  Poll: every {0}s" -f $Poll)
  Write-Host "  Ctrl+C stops this monitor (MediaMTX keeps running)."
  Write-Host "--------------------------------------------------------"
  Write-Host ""
  Write-Host "[RECV] waiting for glasses to publish..."

  $wasOnline = $false
  $activePath = $null
  $prevBytes = $null
  $prevT = $null

  while ($true) {
    $ts = Get-Date -Format "HH:mm:ss"
    $apiReachable = $false
    $data = $null
    $path = $null

    foreach ($p in $paths) {
      try {
        $url = "{0}/v3/paths/get/{1}" -f $Api, $p
        $resp = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction Stop
        $apiReachable = $true
        if ($resp.ready -or $resp.online) {
          $path = $p
          $data = $resp
          break
        }
      } catch {
        # try next path
      }
    }

    if (-not $apiReachable) {
      Write-Host ("[RECV {0}] MediaMTX API unreachable at {1}" -f $ts, $Api)
      Start-Sleep -Seconds $Poll
      continue
    }

    if ($null -eq $data -or [string]::IsNullOrEmpty($path)) {
      if ($wasOnline) {
        Write-Host ("[RECV {0}] stream offline path={1}" -f $ts, $activePath)
        $wasOnline = $false
        $activePath = $null
        $prevBytes = $null
        $prevT = $null
      }
      Start-Sleep -Seconds $Poll
      continue
    }

    if ($path -ne $activePath) {
      $activePath = $path
      $prevBytes = $null
      $prevT = $null
      $transport = "unknown"
      if ($data.source -and $data.source.type) { $transport = [string]$data.source.type }
      Write-Host ("[RECV {0}] publisher online path={1} transport={2}" -f $ts, $path, $transport)
    }

    $width = $null
    $height = $null
    $codec = "?"
    if ($data.tracks2) {
      foreach ($track in $data.tracks2) {
        $props = $track.codecProps
        if ($props -and $props.width -and $props.height) {
          $width = $props.width
          $height = $props.height
          if ($track.codec) { $codec = [string]$track.codec }
          break
        }
      }
    }

    $bytesRx = [int64]0
    if ($null -ne $data.bytesReceived) { $bytesRx = [int64]$data.bytesReceived }
    elseif ($null -ne $data.inboundBytes) { $bytesRx = [int64]$data.inboundBytes }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
    $bitrateKbps = $null
    if ($null -ne $prevBytes -and $null -ne $prevT -and $now -gt $prevT) {
      $delta = [Math]::Max(0, $bytesRx - [int64]$prevBytes)
      $bitrateKbps = ($delta * 8.0 / ($now - $prevT)) / 1000.0
    }
    $prevBytes = $bytesRx
    $prevT = $now

    if ($width -and $height) {
      $res = "{0}x{1}" -f $width, $height
    } else {
      $res = "n/a"
    }
    if ($null -ne $bitrateKbps) {
      $br = "{0:0}" -f $bitrateKbps
    } else {
      $br = "n/a"
    }

    Write-Host ("[RECV {0}] online path={1} resolution={2} codec={3} recvBitrateKbps={4} bytesReceived={5}" -f `
      $ts, $path, $res, $codec, $br, $bytesRx)
    $wasOnline = $true
    Start-Sleep -Seconds $Poll
  }
}

# --- main -------------------------------------------------------------

if (-not (Test-DockerAvailable)) {
  Write-Error "docker not found or Docker Desktop engine is not running. Install/start Docker Desktop and retry."
  exit 1
}

$DetectedIp = Get-LanIp -Override $LanIp
if ([string]::IsNullOrWhiteSpace($DetectedIp)) {
  Write-Host "ERROR: Could not detect a LAN IP."
  Write-Host "Connect Windows to the Mentra Live hotspot (or Wi-Fi), then re-run."
  Write-Host "Or set an explicit IP:"
  Write-Host '  $env:LAN_IP = "192.168.43.XX"'
  Write-Host "  .\start-local-stream.ps1"
  exit 1
}

$env:MTX_WEBRTCADDITIONALHOSTS = $DetectedIp

# IMPORTANT: do not write "$ip:1935" in double quotes - PowerShell treats
# "$ip:1935" as a drive-scoped variable. Use -f or concatenation.
$RtmpPublish = "rtmp://{0}:1935/live/stream" -f $DetectedIp
$SrtPublish = "srt://{0}:8890?streamid=publish:live/stream" -f $DetectedIp
$SrtWatch = "srt://{0}:8890?streamid=read:live/stream" -f $DetectedIp
$HlsWatch = "http://{0}:8888/live/stream" -f $DetectedIp
$WhipPublish = "http://{0}:8889/live/whip" -f $DetectedIp
$WhipWatch = "http://{0}:8889/live" -f $DetectedIp
$RtspWatch = "rtsp://{0}:8554/live/stream" -f $DetectedIp
$ComposeFile = Join-Path $ScriptDir "docker-compose.yml"

Write-Host ("LAN IP                  : {0}" -f $DetectedIp)
Write-Host ("MTX_WEBRTCADDITIONALHOSTS={0}" -f $env:MTX_WEBRTCADDITIONALHOSTS)
Write-Host ""

# Prefer offline image tarball next to this script (no Docker Hub pull).
$LoadOffline = Join-Path $ScriptDir "offline\load-images.ps1"
if (-not (Test-Path -LiteralPath $LoadOffline)) {
  $LoadOffline = Join-Path $ScriptDir "offline/load-images.ps1"
}
if (Test-Path -LiteralPath $LoadOffline) {
  Write-Host "Loading offline MediaMTX image (if needed)..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LoadOffline
  if ($LASTEXITCODE -ne 0) {
    Write-Host ("ERROR: offline image load failed (exit {0})" -f $LASTEXITCODE)
    exit $LASTEXITCODE
  }
} else {
  Write-Host "No offline/ bundle found - docker compose may pull from the network."
}

# Drop any previous broken container (USB bind-mount leftovers).
cmd.exe /c "docker rm -f mentra-local-stream >nul 2>nul"

# Bake mediamtx.yml into an image so we never bind-mount from USB (D:).
# Uses the already-loaded bluenviron/mediamtx:1 base — no network pull.
Write-Host "Building mentra-local-mediamtx:1 (config baked in, no USB file mount)..."
cmd.exe /c "docker build -t mentra-local-mediamtx:1 `"$ScriptDir`""
if ($LASTEXITCODE -ne 0) {
  Write-Host ("ERROR: docker build failed (exit {0})" -f $LASTEXITCODE)
  exit $LASTEXITCODE
}

Write-Host "Starting MediaMTX (RTMP primary, SRT + WHIP available)..."
# Use cmd so docker stderr does not become a PowerShell terminating error.
cmd.exe /c "docker compose -f `"$ComposeFile`" up -d --pull never --no-build"
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARN: compose --pull never --no-build failed; retrying with build..."
  cmd.exe /c "docker compose -f `"$ComposeFile`" up -d --build"
}
if ($LASTEXITCODE -ne 0) {
  Write-Host ("ERROR: docker compose up failed (exit {0})" -f $LASTEXITCODE)
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "--------------------------------------------------------"
Write-Host "PRIMARY - RTMP (recommended)"
Write-Host "  Publish (Livestreamer Custom + Local network):"
Write-Host ("    {0}" -f $RtmpPublish)
Write-Host "  Watch on THIS LAPTOP (phone has no unmanaged preview):"
Write-Host ("    Browser HLS:  {0}/" -f $HlsWatch)
Write-Host ("    VLC -> Open Network: {0}" -f $RtmpPublish)
Write-Host ("    VLC -> Open Network: {0}" -f $RtspWatch)
Write-Host ""
Write-Host "ALSO - SRT (UDP 8890; MediaMTX streamid syntax)"
Write-Host "  Publish (Livestreamer Custom + protocol SRT):"
Write-Host ("    {0}" -f $SrtPublish)
Write-Host "  Watch SRT:"
Write-Host ("    {0}" -f $SrtWatch)
Write-Host "  Or watch the same stream over HLS after SRT publish:"
Write-Host ("    {0}/" -f $HlsWatch)
Write-Host ""
Write-Host "FALLBACK - WHIP / WHEP (WebRTC; needs TCP 8889 + UDP 8189)"
Write-Host "  Publish:"
Write-Host ("    {0}" -f $WhipPublish)
Write-Host "  Watch:"
Write-Host ("    {0}" -f $WhipWatch)
Write-Host "--------------------------------------------------------"
Write-Host ""
Write-Host "Note: Livestreamer Local-network mode shows 'No preview available'"
Write-Host "on the phone by design - watch on the laptop URLs above."
Write-Host ""
Write-Host "Firewall tip (RTMP): allow inbound TCP 1935 for Docker."
Write-Host "Firewall tip (SRT): allow inbound UDP 8890 for Docker."
Write-Host "Firewall/ICE tip (WHIP): allow inbound TCP 8889 and UDP 8189 -"
Write-Host "  if WHIP returns 201 but no video appears, ICE/UDP is blocked."
Write-Host ""
Write-Host "Stop MediaMTX:"
Write-Host ("  docker compose -f {0} down" -f $ComposeFile)
Write-Host ""

Monitor-ReceiveStats -Api $MtxApi -PathsCsv $PathNames -Poll $PollSeconds
