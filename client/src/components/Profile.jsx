import { useState, useEffect, useRef, useCallback } from 'react';
import DashboardLayout from './DashboardLayout';

const s = {
  section: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-primary)',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '16px',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: '700',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.8px',
    marginBottom: '16px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)' },
  input: {
    padding: '9px 12px',
    fontSize: '13px',
    border: '1px solid var(--border-primary)',
    borderRadius: '8px',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
    colorScheme: 'inherit',
  },
  textarea: {
    padding: '9px 12px',
    fontSize: '13px',
    border: '1px solid var(--border-primary)',
    borderRadius: '8px',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '80px',
    resize: 'vertical',
    colorScheme: 'inherit',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 8px',
    borderRadius: '20px',
    fontSize: '11px',
    fontWeight: '600',
  },
};

const EMPTY = {
  full_name: '', email: '', phone: '', date_of_birth: '', gender: '',
  address: '', city: '', province: '', postal_code: '', nationality: 'Indonesia',
  university: '', faculty: '', major: '', gpa: '', graduation_year: '', student_id: '',
  linkedin: '', portfolio: '', github: '',
  skills: '', languages: 'Indonesia, English',
  work_experience: '',
  preference_type: 'both', preference_location: '', preference_field: '',
};

export default function Profile() {
  const [form, setForm] = useState(EMPTY);
  const [cvFile, setCvFile] = useState(null);
  const [cvText, setCvText] = useState('');
  const [cvFilename, setCvFilename] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [activeTab, setActiveTab] = useState('profile');
  const fileRef = useRef();
  const autoSaveTimer = useRef(null);

  useEffect(() => {
    fetch('/api/profile')
      .then(r => r.json())
      .then(d => {
        if (d.profile && d.profile.full_name) {
          setForm(f => ({ ...EMPTY, ...d.profile }));
          if (d.profile.cv_filename) setCvFilename(d.profile.cv_filename);
          if (d.profile.cv_text) setCvText(d.profile.cv_text);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetch('/api/apply-history')
      .then(r => r.json())
      .then(d => setHistory(d.history || []))
      .catch(() => {});
  }, []);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  // Auto-save dengan debounce 2 detik setiap kali form berubah
  const saveProfile = useCallback(async (formData, cvTextData, cvFilenameData, silent = false) => {
    if (!formData.full_name || !formData.email) return;
    try {
      const payload = { ...formData, cv_text: cvTextData, cv_filename: cvFilenameData };
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.success && silent) {
        setAutoSaved(true);
        setTimeout(() => setAutoSaved(false), 2000);
      }
      return d.success;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!form.full_name || !form.email) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      saveProfile(form, cvText, cvFilename, true);
    }, 2000);
    return () => clearTimeout(autoSaveTimer.current);
  }, [form, cvText, cvFilename, saveProfile]);

  const handleCvUpload = async (file) => {
    if (!file) return;
    setCvFile(file);
    setCvFilename(file.name);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: formData });
      const d = await r.json();
      const extractedText = d.content || '';
      if (extractedText) setCvText(extractedText);
      // Langsung simpan CV ke database tanpa perlu klik "Simpan Profil"
      const payload = { ...form, cv_text: extractedText, cv_filename: file.name };
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setMsg({ type: 'success', text: `CV "${file.name}" berhasil dibaca dan disimpan` });
    } catch {
      setMsg({ type: 'error', text: 'Gagal membaca CV' });
    }
  };

  const handleSave = async () => {
    if (!form.full_name || !form.email) {
      setMsg({ type: 'error', text: 'Nama lengkap dan email wajib diisi' });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const ok = await saveProfile(form, cvText, cvFilename, false);
      if (ok) {
        setMsg({ type: 'success', text: 'Profil berhasil disimpan. AI agent siap auto-apply menggunakan data ini.' });
      } else {
        setMsg({ type: 'error', text: 'Gagal menyimpan profil' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Terjadi kesalahan saat menyimpan' });
    } finally {
      setSaving(false);
    }
  };

  const statusColor = (s) => ({
    applied: { bg: '#e3f2fd', color: '#1565c0' },
    pending: { bg: '#fff8e1', color: '#f57f17' },
    accepted: { bg: '#e8f5e9', color: '#2e7d32' },
    rejected: { bg: '#fce4ec', color: '#c62828' },
  }[s] || { bg: 'var(--bg-tertiary)', color: 'var(--text-secondary)' });

  if (loading) return (
    <DashboardLayout>
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>Memuat profil...</div>
    </DashboardLayout>
  );

  return (
    <DashboardLayout>
      <div style={{ padding: '20px', maxWidth: '860px', margin: '0 auto', width: '100%' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="var(--brand)"/>
            </svg>
            <h1 style={{ fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Profil Pelamar</h1>
            {autoSaved && (
              <span style={{
                fontSize: '11px', fontWeight: '600', color: '#2e7d32',
                background: '#e8f5e9', padding: '3px 8px', borderRadius: '20px',
                border: '1px solid #a5d6a7',
              }}>
                ✓ Tersimpan otomatis
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['profile', 'history'].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
                cursor: 'pointer',
                background: activeTab === tab ? 'var(--brand)' : 'var(--bg-tertiary)',
                color: activeTab === tab ? 'white' : 'var(--text-primary)',
                border: activeTab === tab ? '1px solid transparent' : '1px solid var(--border-primary)',
              }}>
                {tab === 'profile' ? 'Data Diri' : `Riwayat Apply (${history.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Alert */}
        {msg && (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', marginBottom: '16px',
            fontSize: '13px', fontWeight: '500',
            background: msg.type === 'success' ? '#e8f5e9' : '#fce4ec',
            color: msg.type === 'success' ? '#2e7d32' : '#c62828',
            border: `1px solid ${msg.type === 'success' ? '#a5d6a7' : '#ef9a9a'}`,
          }}>
            {msg.text}
          </div>
        )}

        {activeTab === 'profile' && (
          <>
            {/* Info banner */}
            <div style={{
              padding: '12px 16px', borderRadius: '10px', marginBottom: '16px',
              background: 'rgba(var(--brand-rgb), 0.08)', border: '1px solid rgba(var(--brand-rgb), 0.2)',
              fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5',
            }}>
              <strong style={{ color: 'var(--text-primary)' }}>Data ini digunakan oleh AI Agent untuk auto-apply.</strong>
              {' '}Isi semua field selengkap mungkin agar AI dapat mengisi form lamaran kerja secara otomatis.
            </div>

            {/* Upload CV */}
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>
                Upload CV
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <button onClick={() => fileRef.current?.click()} style={{
                  padding: '9px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
                  border: '1px solid var(--border-primary)', cursor: 'pointer',
                  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                }}>
                  Pilih File CV
                </button>
                <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt" style={{ display: 'none' }}
                  onChange={e => handleCvUpload(e.target.files[0])} />
                {cvFilename && (
                  <span style={{ ...s.badge, background: '#e8f5e9', color: '#2e7d32' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                    {cvFilename}
                  </span>
                )}
                {cvText && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {cvText.length.toLocaleString()} karakter terdeteksi
                  </span>
                )}
              </div>
              {!cvText && (
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px', marginBottom: 0 }}>
                  Upload CV (PDF/Word) agar AI dapat membaca skill dan pengalaman kamu secara otomatis.
                </p>
              )}
            </div>

            {/* Data Pribadi */}
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08s5.97 1.09 6 3.08c-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
                Data Pribadi
              </div>
              <div style={{ ...s.grid2, marginBottom: '12px' }}>
                <div style={s.field}>
                  <label style={s.label}>Nama Lengkap *</label>
                  <input style={s.input} value={form.full_name} onChange={set('full_name')} placeholder="Nama sesuai KTP" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Email *</label>
                  <input style={s.input} type="email" value={form.email} onChange={set('email')} placeholder="email@gmail.com" />
                </div>
              </div>
              <div style={{ ...s.grid3, marginBottom: '12px' }}>
                <div style={s.field}>
                  <label style={s.label}>No. HP / WhatsApp</label>
                  <input style={s.input} value={form.phone} onChange={set('phone')} placeholder="08xxxxxxxxxx" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Tanggal Lahir</label>
                  <input style={s.input} type="date" value={form.date_of_birth} onChange={set('date_of_birth')} />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Jenis Kelamin</label>
                  <select style={s.input} value={form.gender} onChange={set('gender')}>
                    <option value="">Pilih...</option>
                    <option value="Laki-laki">Laki-laki</option>
                    <option value="Perempuan">Perempuan</option>
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={s.field}>
                  <label style={s.label}>Alamat Lengkap</label>
                  <input style={s.input} value={form.address} onChange={set('address')} placeholder="Jl. Nama Jalan No. XX, RT/RW" />
                </div>
              </div>
              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>Kota</label>
                  <input style={s.input} value={form.city} onChange={set('city')} placeholder="Bekasi" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Provinsi</label>
                  <input style={s.input} value={form.province} onChange={set('province')} placeholder="Jawa Barat" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Kode Pos</label>
                  <input style={s.input} value={form.postal_code} onChange={set('postal_code')} placeholder="17530" />
                </div>
              </div>
            </div>

            {/* Pendidikan */}
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/></svg>
                Pendidikan
              </div>
              <div style={{ ...s.grid2, marginBottom: '12px' }}>
                <div style={s.field}>
                  <label style={s.label}>Universitas</label>
                  <input style={s.input} value={form.university} onChange={set('university')} placeholder="President University" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Fakultas</label>
                  <input style={s.input} value={form.faculty} onChange={set('faculty')} placeholder="Fakultas Teknologi Informasi" />
                </div>
              </div>
              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>Program Studi / Jurusan</label>
                  <input style={s.input} value={form.major} onChange={set('major')} placeholder="Informatika" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>IPK / GPA</label>
                  <input style={s.input} value={form.gpa} onChange={set('gpa')} placeholder="3.75" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Tahun Lulus / Angkatan</label>
                  <input style={s.input} value={form.graduation_year} onChange={set('graduation_year')} placeholder="2025" />
                </div>
              </div>
            </div>

            {/* Skills & Pengalaman */}
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>
                Skill & Pengalaman
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={s.field}>
                  <label style={s.label}>Skill Teknis & Soft Skill</label>
                  <textarea style={s.textarea} value={form.skills} onChange={set('skills')}
                    placeholder="Contoh: JavaScript, Python, React, Microsoft Excel, Komunikasi, Teamwork, Problem Solving..." />
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={s.field}>
                  <label style={s.label}>Bahasa yang Dikuasai</label>
                  <input style={s.input} value={form.languages} onChange={set('languages')} placeholder="Indonesia, English" />
                </div>
              </div>
              <div style={s.field}>
                <label style={s.label}>Pengalaman Kerja / Organisasi</label>
                <textarea style={{ ...s.textarea, minHeight: '100px' }} value={form.work_experience} onChange={set('work_experience')}
                  placeholder="Contoh: Anggota BEM 2023-2024, Peserta magang PT ABC 2023, Freelance web developer..." />
              </div>
            </div>

            {/* Link Profesional */}
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
                Link Profesional
              </div>
              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>LinkedIn</label>
                  <input style={s.input} value={form.linkedin} onChange={set('linkedin')} placeholder="linkedin.com/in/username" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Portfolio / Website</label>
                  <input style={s.input} value={form.portfolio} onChange={set('portfolio')} placeholder="portofolio.com" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>GitHub</label>
                  <input style={s.input} value={form.github} onChange={set('github')} placeholder="github.com/username" />
                </div>
              </div>
            </div>

            {/* Preferensi Lamaran */}
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
                Preferensi Lamaran
              </div>
              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>Tipe Posisi</label>
                  <select style={s.input} value={form.preference_type} onChange={set('preference_type')}>
                    <option value="both">Intern & Career</option>
                    <option value="intern">Intern / Magang saja</option>
                    <option value="career">Career / Full Time saja</option>
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Preferensi Lokasi</label>
                  <input style={s.input} value={form.preference_location} onChange={set('preference_location')} placeholder="Cikarang, Jakarta, Remote" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Bidang yang Diminati</label>
                  <input style={s.input} value={form.preference_field} onChange={set('preference_field')} placeholder="IT, Software, Data" />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingBottom: '20px' }}>
              <button onClick={() => { setForm(EMPTY); setCvText(''); setCvFilename(''); }} style={{
                padding: '10px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
                border: '1px solid var(--border-primary)', cursor: 'pointer',
                background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
              }}>
                Reset
              </button>
              <button onClick={handleSave} disabled={saving} style={{
                padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
                border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
                background: saving ? 'var(--bg-tertiary)' : 'var(--brand)',
                color: saving ? 'var(--text-secondary)' : 'white',
              }}>
                {saving ? 'Menyimpan...' : 'Simpan Profil'}
              </button>
            </div>
          </>
        )}

        {activeTab === 'history' && (
          <div style={s.section}>
            <div style={s.sectionTitle}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
              Riwayat Lamaran
            </div>
            {history.length === 0 ? (
              <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                Belum ada riwayat lamaran. Gunakan AI Agent untuk mulai apply.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {history.map(h => {
                  const sc = statusColor(h.status);
                  return (
                    <div key={h.id} style={{
                      padding: '12px 14px', borderRadius: '10px',
                      border: '1px solid var(--border-primary)',
                      background: 'var(--bg-tertiary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '3px' }}>
                          {h.company} — {h.position}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {new Date(h.applied_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}
                          {h.notes && ` · ${h.notes}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ ...s.badge, background: sc.bg, color: sc.color }}>
                          {h.status}
                        </span>
                        <a href={h.apply_url} target="_blank" rel="noopener noreferrer" style={{
                          fontSize: '11px', color: 'var(--brand)', textDecoration: 'none', fontWeight: '600',
                        }}>
                          Buka →
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
