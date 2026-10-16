/**
 * Cara kerja & batas: what the agent does by itself, what it never does, and how to plug the
 * website's contact form into the sales desk.
 */

import { Section } from './ui.jsx';

export default function AboutTab({ intervalHours = 6 }) {
  return (
    <div className="ag-stack">
      <Section title="Yang dikerjakan agent sendiri">
        <ul className="ag-list">
          <li>Membaca lowongan remote dari sumber resmi (API/RSS) tiap {intervalHours} jam, dan menilainya terhadap profil dan portofolio Anda dengan aturan tertulis.</li>
          <li>Menjawab calon klien yang menulis lewat website atau WhatsApp, dari katalog layanan Anda, lalu mencatatnya sebagai prospek.</li>
          <li>Mengirim <strong>satu laporan harian pukul 19.00 WIB</strong> ke Telegram, dan memberi tahu seketika bila ada prospek serius (di luar jam tenang 22.00–06.00).</li>
          <li>Menjaga dirinya: bila radar berhenti memindai, ia menyalakannya ulang dan mengabari Anda.</li>
        </ul>
      </Section>

      <Section title="Batas yang sengaja dipasang">
        <ul className="ag-list">
          <li>Tidak menyebut harga yang belum Anda setujui, dan tidak menjanjikan tanggal, garansi, atau diskon.</li>
          <li>Selalu mengaku sebagai asisten AI saat menjawab calon klien.</li>
          <li>Kontrak, komplain, permintaan telepon, tenggat mepet, dan anggaran janggal diserahkan ke Anda.</li>
          <li>Tidak menghubungi orang yang belum menulis lebih dulu, dan tidak melewati CAPTCHA.</li>
          <li>Tidak mengarang pengalaman: hanya fakta dari portofolio Anda.</li>
          <li>Belum mengirim lamaran kerja dari sini; tahap itu dibangun terpisah dengan bukti dan pemeriksaan ganda.</li>
        </ul>
      </Section>

      <Section title="Perintah Telegram / WhatsApp pemilik">
        <dl className="ag-cmds">
          <div><dt>laporan agent</dt><dd>laporan harian sekarang</dd></div>
          <div><dt>lowongan baru · pindai lowongan sekarang · status lamaran</dt><dd>radar lowongan</dd></div>
          <div><dt>prospek · prospek 12 · prospek 12 menang 5jt</dt><dd>daftar, detail, dan status klien</dd></div>
          <div><dt>balas prospek 12: pesan</dt><dd>membalas calon klien sendiri</dd></div>
          <div><dt>setujui harga · atur harga webapp 8jt - 25jt</dt><dd>menyetujui atau mengubah harga</dd></div>
          <div><dt>daftar layanan</dt><dd>katalog dan status harganya</dd></div>
        </dl>
      </Section>

      <Section title="Menghubungkan formulir di website" hint="Dipanggil dari server situs Anda (bukan dari browser pengunjung).">
        <pre className="ag-code">{`POST https://wanarai.ashargrosirparfum.com/webhook/inquiry
Content-Type: application/json
X-Wanar-Signature: t=<unix>,v1=<hmac-sha256 "<t>.<body>" dengan SALES_INTAKE_SECRET>

{ "name": "Budi", "contact": "budi@contoh.id", "message": "Butuh toko online…", "website": "" }

→ { "ok": true, "reply": "Halo Budi, …", "escalate": false }`}</pre>
        <p className="ag-note">Kolom <code>website</code> adalah perangkap bot: biarkan kosong dan sembunyikan dari pengunjung. Batas 12 permintaan per jam per alamat IP.</p>
      </Section>
    </div>
  );
}
