/**
 * Test Suite: peringatan kesehatan di laporan harian (bot Telegram tuli, penyedia AI utama ditolak)
 * dan jaminan bahwa skrip deploy tidak lagi menimpa .env / data/ di server secara bawaan.
 */

import { describe, it, expect } from 'vitest';
import nodeFs from 'node:fs';
import { inboxWarnings, providerWarnings } from '../src/career/health.js';

describe('inboxWarnings: bot yang bisa mengirim tetapi tidak membaca pesan', () => {
  it('TELEGRAM_POLLING bukan true -> peringatan jelas', () => {
    const w = inboxWarnings({ status: () => ({ wanted: false, running: false }) });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/PERHATIAN: Telegram tidak membaca pesan masuk \(TELEGRAM_POLLING bukan "true"\)/);
  });
  it('diinginkan tetapi pembaca tidak berjalan -> peringatan lain', () => {
    expect(inboxWarnings({ status: () => ({ wanted: true, running: false }) })[0]).toMatch(/sedang tidak berjalan/);
  });
  it('sehat, tidak ada inbox, atau status error -> kosong (tidak pernah melempar)', () => {
    expect(inboxWarnings({ status: () => ({ wanted: true, running: true }) })).toEqual([]);
    expect(inboxWarnings(null)).toEqual([]);
    expect(inboxWarnings({})).toEqual([]);
    expect(inboxWarnings({ status: () => { throw new Error('boom'); } })).toEqual([]);
  });
});

describe('providerWarnings: penyedia AI utama yang ditolak', () => {
  const mgr = (sk) => ({ failover: { skipReason: (p, m) => (p === 'clouvia' && m === '*' ? sk : null) } });

  it('kunci ditolak -> menyebut penyedia dan alasannya, dan bahwa jawaban pindah ke cadangan', () => {
    const w = providerWarnings(mgr({ why: 'auth' }), { DEFAULT_PROVIDER: 'clouvia' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('penyedia AI utama (clouvia)');
    expect(w[0]).toContain('kunci API ditolak');
    expect(w[0]).toContain('cadangan yang lebih lambat');
  });
  it('alasan lain dipetakan; alasan tak dikenal ditampilkan apa adanya', () => {
    expect(providerWarnings(mgr({ why: 'quota' }), { DEFAULT_PROVIDER: 'Clouvia' })[0]).toContain('kuota habis');
    expect(providerWarnings(mgr({ why: 'aneh' }), { DEFAULT_PROVIDER: 'clouvia' })[0]).toContain('aneh');
  });
  it('penyedia sehat, tanpa DEFAULT_PROVIDER, atau manajer rusak -> kosong', () => {
    expect(providerWarnings(mgr(null), { DEFAULT_PROVIDER: 'clouvia' })).toEqual([]);
    expect(providerWarnings(mgr({ why: 'auth' }), {})).toEqual([]);
    expect(providerWarnings(null, { DEFAULT_PROVIDER: 'clouvia' })).toEqual([]);
    expect(providerWarnings({ failover: { skipReason: () => { throw new Error('x'); } } }, { DEFAULT_PROVIDER: 'clouvia' })).toEqual([]);
  });
});

describe('deploy.ps1 aman secara bawaan', () => {
  const src = nodeFs.readFileSync(new URL('../scripts/deploy/deploy.ps1', import.meta.url), 'utf8');

  it('.env dan data/ dikecualikan KECUALI -IncludeEnv / -IncludeData diminta eksplisit', () => {
    expect(src).toMatch(/\[switch\]\$IncludeEnv/);
    expect(src).toMatch(/\[switch\]\$IncludeData/);
    expect(src).toMatch(/if \(\$IncludeEnv\) \{[\s\S]*?\} else \{ \$ex \+= '--exclude=\.env' \}/);
    expect(src).toMatch(/if \(\$IncludeData\) \{[\s\S]*?\} else \{ \$ex \+= '--exclude=data' \}/);
  });

  it('tidak ada lagi jalur yang mengunggah .env hanya karena sebuah flag LUPA ditulis', () => {
    // bentuk lama: `if ($SkipEnv) { exclude }` -> lupa flag = .env terunggah. Tidak boleh kembali.
    expect(src).not.toMatch(/if \(\$SkipEnv\)\s*\{\s*\$ex \+= '--exclude=\.env'/);
    expect(src).not.toMatch(/if \(\$FreshData\)\s*\{\s*\$ex \+= '--exclude=data'/);
  });
});
