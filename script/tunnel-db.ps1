# SSH tunnel script for Podman API access
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/tunnel-podman.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/tunnel-podman.ps1 -Background
#
# After starting, Podman API is available at: http://localhost:12700

param(
  [switch]$DryRun,
  [switch]$Background
)

$RemoteUser = "brins"
$RemoteHost = "202.155.91.210"
$RemoteSshPort = 22
$RemotePodmanApiPort = 5445
$LocalTunnelPort = 5446

Write-Host "Starting Podman API tunnel: localhost:${LocalTunnelPort} -> ${RemoteHost}:${RemotePodmanApiPort} (SSH port ${RemoteSshPort})" -ForegroundColor Cyan

# Build SSH arguments
$sshArgsArray = @(
  '-p', "$RemoteSshPort",
  '-L', "${LocalTunnelPort}:127.0.0.1:${RemotePodmanApiPort}",
  '-N', "$RemoteUser@$RemoteHost"
)

if ($DryRun) {
  Write-Host "DryRun enabled. SSH command would be:" -ForegroundColor Yellow
  Write-Host ("ssh " + ($sshArgsArray -join ' ')) -ForegroundColor Yellow
  return
}

# Check if port is already in use
$inUse = netstat -ano | Select-String ":$LocalTunnelPort\s"
if ($inUse) {
  Write-Host "Local port $LocalTunnelPort appears to be in use:" -ForegroundColor Yellow
  $inUse | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
  Write-Host "To free the port, kill the process using: taskkill /F /PID <PID>" -ForegroundColor Yellow
  return
}

# Start tunnel
if ($Background) {
  $proc = Start-Process -FilePath ssh -ArgumentList $sshArgsArray -PassThru -WindowStyle Hidden
  Write-Host "Podman API tunnel started in background (PID: $($proc.Id))" -ForegroundColor Green
  Write-Host "Podman API available at: http://localhost:$LocalTunnelPort" -ForegroundColor Green
  Write-Host "To stop: taskkill /F /PID $($proc.Id)" -ForegroundColor Green
} else {
  Write-Host "Starting tunnel in foreground (Ctrl+C to stop)..." -ForegroundColor Cyan
  Write-Host "Podman API will be available at: http://localhost:$LocalTunnelPort" -ForegroundColor Cyan
  & ssh @sshArgsArray
}
