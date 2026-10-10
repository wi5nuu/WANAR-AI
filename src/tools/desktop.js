/**
 * src/tools/desktop.js
 *
 * Local desktop automation for the user's OWN machine:
 *   - mouse_control : move / click / scroll the OS cursor
 *   - screen_capture: screenshot the desktop so the AI can "see" the screen
 *
 * Safety:
 *   - Disabled unless MOUSE_CONTROL_ENABLED=true (explicit opt-in per machine).
 *   - Windows only; uses user32.dll via PowerShell (no native npm build).
 *   - Every action is visible and user-initiated through a tool call; nothing
 *     runs in the background and nothing is hidden.
 */

import { execFile } from 'node:child_process';

const ENABLED = String(process.env.MOUSE_CONTROL_ENABLED || 'false').toLowerCase() === 'true';
const IS_WINDOWS = process.platform === 'win32';

function runPowerShell(script, timeoutMs = 15000, extraEnv = null) {
  return new Promise((resolve) => {
    // -EncodedCommand avoids all quoting/escaping pitfalls with here-strings.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 500) });
        resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      }
    );
  });
}

const PREFIX = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WanarWin {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
}
'@
`;

function moveScript(x, y, smooth) {
  if (!smooth) {
    return `${PREFIX}
[WanarWin]::SetCursorPos(${x}, ${y}) | Out-Null
$p = New-Object WanarWin+PT
[WanarWin]::GetCursorPos([ref]$p) | Out-Null
Write-Output ("$($p.X),$($p.Y)")`;
  }
  // Gerakan human-like: easing ease-in-out, langkah acak 28-44,
  // jeda acak per langkah, overshoot kecil + koreksi akhir, micro-jitter.
  return `${PREFIX}
Add-Type -AssemblyName System.Windows.Forms
$sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$tx = [Math]::Max(0, [Math]::Min(${x}, $sw.Width - 1))
$ty = [Math]::Max(0, [Math]::Min(${y}, $sw.Height - 1))
$cur = New-Object WanarWin+PT
[WanarWin]::GetCursorPos([ref]$cur) | Out-Null
$sx = $cur.X; $sy = $cur.Y
$rnd = New-Object System.Random
$steps = $rnd.Next(28, 45)
$ox = 0; $oy = 0
$dist = [Math]::Sqrt(($tx - $sx) * ($tx - $sx) + ($ty - $sy) * ($ty - $sy))
if ($dist -gt 120) { $ox = $rnd.Next(-6, 7); $oy = $rnd.Next(-6, 7) }
for ($i = 1; $i -le $steps; $i++) {
  $t = $i / $steps
  $e = $t * $t * (3 - 2 * $t)
  $nx = [int]($sx + ($tx + $ox - $sx) * $e + $rnd.Next(-1, 2))
  $ny = [int]($sy + ($ty + $oy - $sy) * $e + $rnd.Next(-1, 2))
  [WanarWin]::SetCursorPos($nx, $ny) | Out-Null
  Start-Sleep -Milliseconds $rnd.Next(8, 20)
}
if ($ox -ne 0 -or $oy -ne 0) {
  Start-Sleep -Milliseconds $rnd.Next(30, 80)
  $half = $steps / 2
  for ($i = 1; $i -le $half; $i++) {
    $t = $i / $half
    $nx = [int](($tx + $ox) + ($tx - ($tx + $ox)) * $t)
    $ny = [int](($ty + $oy) + ($ty - ($ty + $oy)) * $t)
    [WanarWin]::SetCursorPos($nx, $ny) | Out-Null
    Start-Sleep -Milliseconds $rnd.Next(8, 16)
  }
}
[WanarWin]::SetCursorPos($tx, $ty) | Out-Null
$p = New-Object WanarWin+PT
[WanarWin]::GetCursorPos([ref]$p) | Out-Null
Write-Output ("$($p.X),$($p.Y)")`;
}

function clickScript(x, y, downFlag, upFlag, button, humanDelay = true) {
  return `${PREFIX}
${x !== null && y !== null ? `[WanarWin]::SetCursorPos(${x}, ${y}) | Out-Null` : ''}
${humanDelay ? '$r = New-Object System.Random; Start-Sleep -Milliseconds $r.Next(60, 140)' : 'Start-Sleep -Milliseconds 60'}
[WanarWin]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[WanarWin]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "clicked:${button}"`;
}

function smoothScrollScript(notches, direction) {
  // direction: 1 = naik, -1 = turun. Scroll per-notch dengan jeda manusiawi
  // agar halaman sempat me-render lazy content dan terlihat alami.
  const total = Math.max(1, Math.min(20, Math.abs(notches || 3)));
  const sign = direction >= 0 ? 1 : -1;
  return `${PREFIX}
$r = New-Object System.Random
for ($i = 0; $i -lt ${total}; $i++) {
  [WanarWin]::mouse_event(0x0800, 0, 0, ${120 * sign}, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $r.Next(60, 160)
}
Write-Output "scrolled:${total * sign}"`;
}

function dragScript(x1, y1, x2, y2) {
  // Drag manusiawi: gerak halus ke titik awal, tahan klik kiri,
  // seret dengan easing ke titik akhir, lalu lepas.
  return `${PREFIX}
$rnd = New-Object System.Random
function Wanar-Glide($fx, $fy, $tx, $ty, $steps) {
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / $steps
    $e = $t * $t * (3 - 2 * $t)
    [WanarWin]::SetCursorPos([int]($fx + ($tx - $fx) * $e), [int]($fy + ($ty - $fy) * $e)) | Out-Null
    Start-Sleep -Milliseconds $rnd.Next(8, 18)
  }
}
$cur = New-Object WanarWin+PT
[WanarWin]::GetCursorPos([ref]$cur) | Out-Null
Wanar-Glide $cur.X $cur.Y ${x1} ${y1} $rnd.Next(20, 32)
Start-Sleep -Milliseconds $rnd.Next(80, 160)
[WanarWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds $rnd.Next(60, 120)
Wanar-Glide ${x1} ${y1} ${x2} ${y2} $rnd.Next(24, 40)
Start-Sleep -Milliseconds $rnd.Next(40, 90)
[WanarWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "dragged:${x1},${y1}-${x2},${y2}"`;
}

function typeScript() {
  // Teks diambil dari env WANAR_TYPE_TEXT (anti masalah quoting/unicode).
  // Diketik via clipboard + Ctrl+V agar karakter Indonesia/emoji akurat.
  return `
Add-Type -AssemblyName System.Windows.Forms
$text = $env:WANAR_TYPE_TEXT
if ([string]::IsNullOrEmpty($text)) { Write-Output "typed:0"; exit }
[System.Windows.Forms.Clipboard]::SetText($text)
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 120
Write-Output ("typed:" + $text.Length)`;
}

function positionScript() {  return `${PREFIX}
$p = New-Object WanarWin+PT
[WanarWin]::GetCursorPos([ref]$p) | Out-Null
Write-Output ("$($p.X),$($p.Y)")`;
}

function screenInfoScript() {
  return `
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("$($b.Width)x$($b.Height)")`;
}

function captureScript(outPath, x, y, w, h) {
  const region = (x !== null && y !== null && w && h)
    ? `New-Object System.Drawing.Rectangle(${x}, ${y}, ${w}, ${h})`
    : `[System.Windows.Forms.Screen]::PrimaryScreen.Bounds`;
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = ${region}
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved"`;
}

export const desktopTools = [
  {
    type: 'function',
    function: {
      name: 'mouse_control',
      description: 'Kendalikan mouse & keyboard di layar user (mesin lokal, terlihat jelas oleh user). Aksi: move (gerak halus seperti manusia), click, double_click, right_click, drag (seret, mis. slider/scrollbar), scroll (scroll halaman dengan halus, positif naik / negatif turun, 120 = 1 notch), type (ketik teks di fokus saat ini), position (baca posisi cursor). Alur yang benar: screen_capture dulu untuk melihat layar, lalu move/click dengan koordinat akurat, verifikasi dengan position.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'position'] },
          x: { type: 'number', description: 'Koordinat X (untuk move/click/drag awal)' },
          y: { type: 'number', description: 'Koordinat Y (untuk move/click/drag awal)' },
          x2: { type: 'number', description: 'Koordinat X akhir (untuk drag)' },
          y2: { type: 'number', description: 'Koordinat Y akhir (untuk drag)' },
          smooth: { type: 'boolean', description: 'Gerak halus bertahap seperti manusia (default true untuk move)' },
          amount: { type: 'number', description: 'Jumlah scroll wheel; positif naik, negatif turun; 120 = 1 notch (mis. -360 = turun 3 notch). Default -360.' },
          text: { type: 'string', description: 'Teks yang diketik (untuk type, maks 2000 karakter)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_capture',
      description: 'Ambil screenshot layar user (desktop) agar kamu bisa melihat apa yang ada di layar sebelum menggerakkan cursor atau mengklik.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Kiri area (opsional)' },
          y: { type: 'number', description: 'Atas area (opsional)' },
          width: { type: 'number', description: 'Lebar area (opsional)' },
          height: { type: 'number', description: 'Tinggi area (opsional)' },
        },
        required: [],
      },
    },
  },
];

export async function executeDesktopTool(name, args) {
  if (!IS_WINDOWS) return { error: 'Desktop control is only supported on Windows.' };
  if (!ENABLED) {
    return {
      error: 'Mouse control is disabled. Set MOUSE_CONTROL_ENABLED=true in .env and restart the server to enable it.',
    };
  }

  if (name === 'mouse_control') {
    const { action, x, y, x2, y2, smooth, amount, text } = args || {};
    switch (action) {
      case 'position': {
        const r = await runPowerShell(positionScript());
        if (!r.ok) return { error: 'Failed to read cursor position', details: r.error };
        const [cx, cy] = r.stdout.split(',').map(Number);
        return { success: true, x: cx, y: cy };
      }
      case 'move': {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'move requires numeric x and y' };
        const r = await runPowerShell(moveScript(Math.round(x), Math.round(y), smooth !== false), 25000);
        if (!r.ok) return { error: 'Failed to move cursor', details: r.error };
        const [cx, cy] = r.stdout.split(',').map(Number);
        return { success: true, movedTo: { x: cx, y: cy }, target: { x: Math.round(x), y: Math.round(y) } };
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const px = Number.isFinite(x) ? Math.round(x) : null;
        const py = Number.isFinite(y) ? Math.round(y) : null;
        if (action === 'right_click') {
          const r = await runPowerShell(clickScript(px, py, '0x0008', '0x0010', 'right'), 20000);
          if (!r.ok) return { error: 'Failed to right-click', details: r.error };
          return { success: true, action: 'right_click', at: px !== null ? { x: px, y: py } : 'current' };
        }
        const r = await runPowerShell(clickScript(px, py, '0x0002', '0x0004', 'left'), 20000);
        if (!r.ok) return { error: 'Failed to click', details: r.error };
        if (action === 'double_click') {
          await new Promise(res => setTimeout(res, 90));
          await runPowerShell(clickScript(px, py, '0x0002', '0x0004', 'left', false), 20000);
        }
        return { success: true, action, at: px !== null ? { x: px, y: py } : 'current' };
      }
      case 'drag': {
        if (![x, y, x2, y2].every(Number.isFinite)) {
          return { error: 'drag requires numeric x, y, x2 and y2' };
        }
        const r = await runPowerShell(
          dragScript(Math.round(x), Math.round(y), Math.round(x2), Math.round(y2)), 30000
        );
        if (!r.ok) return { error: 'Failed to drag', details: r.error };
        return { success: true, action: 'drag', from: { x: Math.round(x), y: Math.round(y) }, to: { x: Math.round(x2), y: Math.round(y2) } };
      }
      case 'type': {
        if (typeof text !== 'string' || text.length === 0) return { error: 'type requires a non-empty text string' };
        if (text.length > 2000) return { error: 'type text too long (max 2000 characters)' };
        const r = await runPowerShell(typeScript(), 20000, { WANAR_TYPE_TEXT: text });
        if (!r.ok) return { error: 'Failed to type text', details: r.error };
        return { success: true, action: 'type', chars: text.length, note: 'Typed via clipboard paste. Ensure the target field was focused (click it first).' };
      }
      case 'scroll': {
        const raw = Number.isFinite(amount) ? Math.round(amount) : -360;
        const notches = Math.max(-20, Math.min(20, Math.round(raw / 120) || (raw > 0 ? 1 : -1)));
        const r = await runPowerShell(smoothScrollScript(Math.abs(notches), notches > 0 ? 1 : -1), 25000);
        if (!r.ok) return { error: 'Failed to scroll', details: r.error };
        return { success: true, scrolled_notches: notches, direction: notches > 0 ? 'up' : 'down' };
      }
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  if (name === 'screen_capture') {
    const info = await runPowerShell(screenInfoScript());
    if (!info.ok) return { error: 'Failed to read screen size', details: info.error };
    const [sw, sh] = info.stdout.split('x').map(Number);

    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const outPath = path.join(os.tmpdir(), `wanar-screen-${Date.now()}.jpg`);

    const { x = null, y = null, width = null, height = null } = args || {};
    const r = await runPowerShell(captureScript(outPath, x, y, width, height), 20000);
    if (!r.ok) return { error: 'Failed to capture screen', details: r.error };

    try {
      const buf = fs.readFileSync(outPath);
      fs.unlinkSync(outPath);
      return {
        success: true,
        screen: { width: sw, height: sh },
        screenshot_base64: buf.toString('base64'),
        note: 'Desktop screenshot. Cursor position can be read with mouse_control action=position.',
      };
    } catch (e) {
      return { error: 'Failed to read screenshot file', details: e.message };
    }
  }

  return { error: `Unknown desktop tool: ${name}` };
}

export default { desktopTools, executeDesktopTool };
