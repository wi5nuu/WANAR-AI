<#
.SYNOPSIS
  Deploy Wanar AI ke VPS Ubuntu (build → upload → setup ringan).

.DESCRIPTION
  1. Build frontend (client/dist)           — kecuali -SkipBuild
  2. Kemas source jadi tar.gz (tanpa node_modules/.git/logs/tests)
  3. Upload + ekstrak ke /opt/wanar-ai
  4. Jalankan setup-vps.sh di VPS (Node, swap, npm ci --omit=optional,
     systemd, logrotate, firewall)

.EXAMPLE
  .\scripts\deploy\deploy.ps1 -Remote legionasharparfum@103.197.189.21
  .\scripts\deploy\deploy.ps1 -Remote user@ip -WithBrowser      # + Chromium
  .\scripts\deploy\deploy.ps1 -Remote user@ip -SetupOnly        # ulang setup saja
  .\scripts\deploy\deploy.ps1 -Remote user@ip -IncludeEnv       # HANYA pemasangan pertama: unggah .env laptop

  AMAN SECARA BAWAAN: .env dan data/ di VPS TIDAK PERNAH ditimpa kecuali Anda menulis -IncludeEnv / -IncludeData.
  (Dulu keduanya ikut terunggah kalau lupa -SkipEnv / -FreshData: itulah yang membuat setelan email, polling
  Telegram, dan penyedia AI utama di server tertimpa isi .env laptop.)
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Remote,

  [string]$Dir = '/opt/wanar-ai',
  # 3000 is taken by the production store (PM2) on this VPS — never reuse it.
  [int]$Port = 3100,

  [switch]$SkipBuild,    # tidak build ulang frontend
  [switch]$IncludeEnv,   # SENGAJA unggah .env laptop (menimpa .env VPS!). Bawaan: tidak diunggah
  [switch]$IncludeData,  # SENGAJA unggah data/ laptop (menimpa DB VPS!). Bawaan: tidak diunggah
  [switch]$SkipEnv,      # (lama, tidak berpengaruh lagi: sudah bawaan)
  [switch]$FreshData,    # (lama, tidak berpengaruh lagi: sudah bawaan)
  [switch]$SetupOnly,    # lewati build & upload, hanya jalankan setup
  [switch]$OpenFirewall, # buka port aplikasi di ufw (hanya bila TANPA nginx/reverse proxy)
  [switch]$WithBrowser   # pasang Playwright + Chromium di VPS
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # .../wanar-ai
$setupLocal = Join-Path $PSScriptRoot 'setup-vps.sh'
$tgz = Join-Path $env:TEMP 'wanar-deploy.tgz'

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }

# ── 0. Pra-syarat ─────────────────────────────────────────────────────────
foreach ($tool in 'ssh', 'scp', 'tar') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Perintah '$tool' tidak ditemukan. Install OpenSSH Client (Windows Features) dulu."
  }
}
if (-not (Test-Path $setupLocal)) { throw "setup-vps.sh tidak ada: $setupLocal" }

# ── 1. Build frontend ─────────────────────────────────────────────────────
if (-not $SetupOnly -and -not $SkipBuild) {
  Step 'Build frontend (client/dist)'
  if (-not (Test-Path (Join-Path $root 'client\node_modules'))) {
    Write-Host '   client/node_modules belum ada — npm ci dulu...' -ForegroundColor Yellow
    Push-Location (Join-Path $root 'client')
    npm ci --no-audit --no-fund
    Pop-Location
  }
  Push-Location (Join-Path $root 'client')
  npm run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Build frontend gagal' }
  Pop-Location
  Ok 'client/dist siap'
}

# ── 2. Kemas source ───────────────────────────────────────────────────────
if (-not $SetupOnly) {
  Step 'Kemas source (tanpa node_modules/.git/logs/tests)'
  $ex = @(
    '--exclude=node_modules',
    '--exclude=client/node_modules',
    '--exclude=.git',
    '--exclude=logs',
    '--exclude=tests',
    '--exclude=.claude',
    '--exclude=*.log'
  )
  # Rahasia dan data hidup di server: tidak pernah ditimpa tanpa izin eksplisit.
  if ($IncludeEnv) {
    Write-Host '   PERINGATAN: -IncludeEnv menimpa .env di VPS dengan .env laptop.' -ForegroundColor Yellow
  } else { $ex += '--exclude=.env' }
  if ($IncludeData) {
    Write-Host '   PERINGATAN: -IncludeData menimpa data/ (termasuk wanar.db) di VPS dengan data laptop.' -ForegroundColor Yellow
  } else { $ex += '--exclude=data' }

  if (Test-Path $tgz) { Remove-Item $tgz -Force }
  & tar.exe -czf $tgz -C $root @ex .
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tgz)) { throw 'Gagal membuat tarball' }

  $size = [math]::Round((Get-Item $tgz).Length / 1MB, 2)
  Ok "tarball $size MB → $tgz"

  # Pastikan tidak ada node_modules yang ikut (bocor ±250MB)
  $leak = & tar.exe -tzf $tgz | Select-String -Pattern 'node_modules' | Select-Object -First 3
  if ($leak) { throw "node_modules ikut terbawa:`n$leak" }

  Step "Upload ke ${Remote}:${Dir}"
  & scp -q $tgz "${Remote}:/tmp/wanar-deploy.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'scp tarball gagal' }

  $mkdir = "sudo mkdir -p '$Dir' && sudo tar xzf /tmp/wanar-deploy.tgz -C '$Dir' && rm -f /tmp/wanar-deploy.tgz && echo EXTRACT_OK"
  & ssh $Remote $mkdir
  if ($LASTEXITCODE -ne 0) { throw 'Ekstrak di VPS gagal' }
  Ok 'source terupload'
}

# ── 3. Setup di VPS ───────────────────────────────────────────────────────
Step 'Setup di VPS (Node, swap, npm ci ringan, systemd)'
& scp -q $setupLocal "${Remote}:/tmp/setup-vps.sh"

$setupArgs = @('bash', '/tmp/setup-vps.sh', '--dir', $Dir, '--port', "$Port")
if (-not $OpenFirewall) { $setupArgs += '--no-firewall' }   # akses lewat nginx → port tetap tertutup
if ($WithBrowser) { $setupArgs += '--with-browser' }

# Jalankan setup. Tanpa TTY dulu (aman untuk sudo tanpa password); bila gagal
# dan ada TTY, ulangi dengan -t agar sudo bisa meminta password interaktif.
# Catatan: jangan redirect stderr di sini — PowerShell 5.1 mengubahnya jadi
# NativeCommandError dan EAP=Stop mematikan skrip padahal setup sukses.
$cmd = "sudo $($setupArgs -join ' ')"
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& ssh -o BatchMode=yes $Remote $cmd
$sshExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($sshExit -ne 0) {
  if (-not [Console]::IsInputRedirected) {
    Write-Host '   (ulang dengan TTY untuk prompt password sudo...)' -ForegroundColor Yellow
    & ssh -t $Remote $cmd
    if ($LASTEXITCODE -ne 0) { throw 'Setup di VPS gagal — lihat pesan di atas' }
  } else {
    throw 'Setup di VPS gagal — lihat pesan di atas'
  }
}

# ── 4. Selesai ────────────────────────────────────────────────────────────
if (Test-Path $tgz) { Remove-Item $tgz -Force }

$hostName = $Remote -replace '^[^@]+@', '' -replace ':.*$', ''
Write-Host ''
Write-Host '================ DEPLOY SELESI ================' -ForegroundColor Green
Write-Host " URL lokal : http://127.0.0.1:$Port"
Write-Host " Host      : $hostName"
Write-Host " Service   : ssh $Remote `"sudo systemctl status wanar`""
Write-Host " Log       : ssh $Remote `"journalctl -u wanar -f`""
Write-Host " Restart   : ssh $Remote `"sudo systemctl restart wanar`""
Write-Host '================================================' -ForegroundColor Green
