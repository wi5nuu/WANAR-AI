import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/server.js';

// A PNG signature followed by garbage: the kind of file that used to crash the OCR worker
// ("libpng error: IDAT: incorrect data check") and take the whole server down.
const BROKEN_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-then-garbage-not-a-real-image'),
]);

describe('foto/gambar tidak diterima (fitur upload foto dihapus)', () => {
  it.each([
    ['rusak.png', 'image/png'],
    ['foto.jpg', 'image/jpeg'],
    ['ikon.svg', 'image/svg+xml'],
    ['kamera.webp', 'image/webp'],
  ])('menolak %s dengan 400 dan pesan yang jelas, server tetap hidup', async (name, type) => {
    const res = await request(app).post('/api/upload').attach('file', BROKEN_PNG, { filename: name, contentType: type });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/tidak|not allowed|didukung/i);
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('gambar yang menyamar sebagai application/octet-stream juga ditolak lewat ekstensi', async () => {
    const res = await request(app).post('/api/upload').attach('file', BROKEN_PNG, { filename: 'foto.jpeg', contentType: 'application/octet-stream' });
    expect(res.status).toBe(400);
  });

  it('dokumen teks tetap bisa diunggah dan dibaca', async () => {
    const res = await request(app).post('/api/upload').attach('file', Buffer.from('halo dunia\nini catatan'), { filename: 'catatan.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.content).toMatch(/halo dunia/);
    expect(res.body).not.toHaveProperty('imageData');
  });
});
