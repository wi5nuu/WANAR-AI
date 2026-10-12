<#
.SYNOPSIS
  Menjalankan Wanar AI sebagai tugas latar belakang yang tahan restart (Windows Task Scheduler).

.DESCRIPTION
  Mengapa perlu: penjadwal otomasi berjalan DI DALAM proses server. Jika server
  mati, job tidak jalan. Tugas ini:
    - memulai server otomatis setiap kali Anda login ke Windows
    - memulai ulang otomatis bila proses crash (maks 999x, jeda 1 menit)
    - tidak berhenti karena baterai / tidak ada batas waktu eksekusi
    - menulis log ke logs\server.log

  Tidak membutuhkan hak Administrator (berjalan sebagai user Anda).
  Catatan: berhenti saat user logout / komputer dimatikan atau tidur — itu batas
  alami komputer biasa. Job yang terlewat <= AUTOMATION_CATCHUP_HOURS (default 6
  jam) akan dikejar otomatis saat server hidup kembali.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\service\wanar-service.ps1 install
  powershell -ExecutionPolicy Bypass -File scripts\service\wanar-service.ps1 status
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'WanarAI'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LogDir = Join-Path $Root 'logs'
$Port = if ($env:PORT) { $env:PORT } else { '3000' }

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'Node.js tidak ditemukan di PATH. Install Node.js 18+ terlebih dahulu.' }
  return $cmd.Source
}

function Get-TaskOrNull {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Show-Status {
  $task = Get-TaskOrNull
  if (-not $task) {
    Write-Host "Tugas '$TaskName' belum terpasang. Jalankan: install" -ForegroundColor Yellow
  } else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("Tugas      : {0} ({1})" -f $TaskName, $task.State)
    Write-Host ("Run terakhir: {0} | hasil: {1}" -f $info.LastRunTime, $info.LastTaskResult)
  }
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 4
    Write-Host ("Server     : HIDUP (HTTP {0}) di http://localhost:{1}" -f $r.StatusCode, $Port) -ForegroundColor Green
  } catch {
    Write-Host "Server     : TIDAK merespons di port $Port" -ForegroundColor Red
  }
}

switch ($Action) {
  'install' {
    $node = Get-NodePath
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $log = Join-Path $LogDir 'server.log'

    # cmd /c supaya stdout+stderr bisa diarahkan ke file log.
    $argLine = '/c ""{0}" "{1}" >> "{2}" 2>&1"' -f $node, (Join-Path $Root 'src\server.js'), $log
    $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $argLine -WorkingDirectory $Root
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $set = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew
    $prin = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Principal $prin `
      -Description 'Wanar AI server + penjadwal otomasi (otomatis start saat login, restart bila crash)' -Force | Out-Null
    Write-Host "Terpasang. Server akan otomatis start tiap login." -ForegroundColor Green
    Write-Host "Memulai sekarang..."
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 6
    Show-Status
  }
  'uninstall' {
    if (Get-TaskOrNull) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "Tugas '$TaskName' dihapus." -ForegroundColor Green
    } else {
      Write-Host "Tugas '$TaskName' memang belum terpasang."
    }
  }
  'start'   { Start-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 5; Show-Status }
  'stop'    { Stop-ScheduledTask -TaskName $TaskName; Write-Host 'Dihentikan.' }
  'restart' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 5
    Show-Status
  }
  'status'  { Show-Status }
}
