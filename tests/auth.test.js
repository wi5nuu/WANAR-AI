/**
 * Test Suite: auth.js
 * Covers: verifyToken, authMiddleware, adminOnly, checkUserTokenLimit, getUserDailyLimit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set env sebelum import — JWT_SECRET_FINAL akan pakai nilai ini
process.env.USER_TOKEN_DAILY_LIMIT = '10000';
process.env.NODE_ENV = 'test';

// adminOnly sekarang membaca role dari database (bukan dari klaim token), jadi
// database di-mock agar tes deterministik dan tidak menyentuh DB asli.
vi.mock('../src/database.js', () => ({
  findOrCreateUser: vi.fn(),
  getUserById: vi.fn(() => null),
  getUserTokensToday: vi.fn(async () => 0),
  recordUserTokens: vi.fn(),
}));

import { verifyToken, authMiddleware, adminOnly, getUserDailyLimit, JWT_SECRET_FINAL } from '../src/auth.js';
import { getUserById } from '../src/database.js';
import jwt from 'jsonwebtoken';

// Gunakan JWT_SECRET_FINAL (nilai yang benar-benar dipakai modul) agar token valid
function makeToken(payload, opts = { expiresIn: '7d' }) {
  return jwt.sign(payload, JWT_SECRET_FINAL, opts);
}

function makeExpiredToken(payload) {
  return jwt.sign(payload, JWT_SECRET_FINAL, { expiresIn: '-1s' });
}

function makeWrongSecretToken(payload) {
  return jwt.sign(payload, 'totally-wrong-secret', { expiresIn: '7d' });
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

function mockReq(token = null, overrides = {}) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    user: null,
    ...overrides,
  };
}

// ==================== TESTS ====================

describe('JWT_SECRET_FINAL', () => {
  it('adalah string non-kosong', () => {
    expect(typeof JWT_SECRET_FINAL).toBe('string');
    expect(JWT_SECRET_FINAL.length).toBeGreaterThan(0);
  });

  it('dapat digunakan untuk sign dan verify token', () => {
    const token = jwt.sign({ id: 1 }, JWT_SECRET_FINAL, { expiresIn: '1h' });
    const payload = jwt.verify(token, JWT_SECRET_FINAL);
    expect(payload.id).toBe(1);
  });
});

describe('verifyToken', () => {
  it('mengembalikan payload untuk token valid', () => {
    const token = makeToken({ id: 1, role: 'user', name: 'Wisnu', email: 'w@test.com' });
    const payload = verifyToken(token);
    expect(payload).toBeTruthy();
    expect(payload.id).toBe(1);
    expect(payload.role).toBe('user');
    expect(payload.name).toBe('Wisnu');
  });

  it('mengembalikan null untuk token expired', () => {
    const token = makeExpiredToken({ id: 2, role: 'user' });
    expect(verifyToken(token)).toBeNull();
  });

  it('mengembalikan null untuk token dengan secret salah', () => {
    const token = makeWrongSecretToken({ id: 3, role: 'user' });
    expect(verifyToken(token)).toBeNull();
  });

  it('mengembalikan null untuk string acak', () => {
    expect(verifyToken('bukan-token-sama-sekali')).toBeNull();
  });

  it('mengembalikan null untuk string kosong', () => {
    expect(verifyToken('')).toBeNull();
  });

  it('mengembalikan null untuk undefined', () => {
    expect(verifyToken(undefined)).toBeNull();
  });

  it('mengembalikan null untuk null', () => {
    expect(verifyToken(null)).toBeNull();
  });

  it('token admin memiliki role admin di payload', () => {
    const token = makeToken({ id: 99, role: 'admin', email: 'admin@test.com' });
    const payload = verifyToken(token);
    expect(payload).toBeTruthy();
    expect(payload.role).toBe('admin');
  });

  it('token superadmin dapat diverifikasi', () => {
    const token = makeToken({ id: 100, role: 'superadmin', email: 'sa@test.com' });
    const payload = verifyToken(token);
    expect(payload).toBeTruthy();
    expect(payload.role).toBe('superadmin');
  });

  it('payload mengandung iat dan exp fields', () => {
    const token = makeToken({ id: 1, role: 'user' });
    const payload = verifyToken(token);
    expect(payload).toBeTruthy();
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });
});

describe('authMiddleware', () => {
  it('memanggil next() untuk token valid', () => {
    const token = makeToken({ id: 1, role: 'user', name: 'Test' });
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeTruthy();
    expect(req.user.id).toBe(1);
  });

  it('mengembalikan 401 jika tidak ada header Authorization', () => {
    const req = mockReq(null);
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 401 jika header bukan Bearer', () => {
    const req = { headers: { authorization: 'Basic sometoken' }, user: null };
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 401 untuk token expired', () => {
    const token = makeExpiredToken({ id: 5, role: 'user' });
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 401 untuk token palsu', () => {
    const req = mockReq('ini.bukan.token');
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('token dengan secret salah ditolak', () => {
    const token = makeWrongSecretToken({ id: 1, role: 'user' });
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('req.user terset dengan benar setelah autentikasi', () => {
    const payload = { id: 42, role: 'admin', name: 'Admin User', email: 'admin@test.com' };
    const token = makeToken(payload);
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(req.user).toBeTruthy();
    expect(req.user.id).toBe(42);
    expect(req.user.role).toBe('admin');
    expect(req.user.name).toBe('Admin User');
  });

  it('mengembalikan 401 jika header Authorization ada tapi kosong setelah Bearer', () => {
    const req = { headers: { authorization: 'Bearer ' }, user: null };
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('adminOnly middleware', () => {
  // adminOnly re-reads the role from the DB, so each test declares what the
  // database says about that user id.
  beforeEach(() => {
    getUserById.mockReset();
  });

  it('memanggil next() untuk user dengan role admin', () => {
    getUserById.mockReturnValue({ id: 1, role: 'admin' });
    const req = { user: { id: 1, role: 'admin' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('memanggil next() untuk user dengan role superadmin', () => {
    getUserById.mockReturnValue({ id: 2, role: 'superadmin' });
    const req = { user: { id: 2, role: 'superadmin' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('menolak ketika token mengklaim admin tetapi database menyatakan user biasa', () => {
    // Skenario pencabutan hak akses: token lama masih membawa role "admin".
    getUserById.mockReturnValue({ id: 6, role: 'user' });
    const req = { user: { id: 6, role: 'admin' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('menolak ketika user sudah tidak ada di database', () => {
    getUserById.mockReturnValue(undefined);
    const req = { user: { id: 99, role: 'superadmin' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 403 untuk role user biasa', () => {
    getUserById.mockReturnValue({ id: 3, role: 'user' });
    const req = { user: { id: 3, role: 'user' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Admin access required');
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 403 jika req.user null', () => {
    const req = { user: null };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 403 untuk role editor', () => {
    getUserById.mockReturnValue({ id: 4, role: 'editor' });
    const req = { user: { id: 4, role: 'editor' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('mengembalikan 403 untuk role member', () => {
    getUserById.mockReturnValue({ id: 5, role: 'member' });
    const req = { user: { id: 5, role: 'member' } };
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('getUserDailyLimit', () => {
  it('mengembalikan limit sesuai env USER_TOKEN_DAILY_LIMIT', () => {
    const limit = getUserDailyLimit();
    expect(limit).toBe(10000);
  });

  it('mengembalikan angka integer positif', () => {
    const limit = getUserDailyLimit();
    expect(typeof limit).toBe('number');
    expect(limit).toBeGreaterThan(0);
    expect(Number.isInteger(limit)).toBe(true);
  });
});

describe('checkUserTokenLimit', () => {
  it('fungsi checkUserTokenLimit dapat diimport', async () => {
    const { checkUserTokenLimit } = await import('../src/auth.js');
    expect(typeof checkUserTokenLimit).toBe('function');
  });
});

describe('JWT token generation', () => {
  it('token dengan expiresIn 7d valid selama 7 hari', () => {
    const token = makeToken({ id: 1, role: 'user' });
    const payload = verifyToken(token);
    expect(payload).toBeTruthy();
    const sevenDaysFromNow = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    expect(payload.exp).toBeGreaterThan(sevenDaysFromNow - 60);
    expect(payload.exp).toBeLessThanOrEqual(sevenDaysFromNow + 60);
  });

  it('token berbeda untuk payload yang sama tapi waktu berbeda', async () => {
    const payload = { id: 1, role: 'user' };
    const token1 = makeToken(payload);
    await new Promise(r => setTimeout(r, 1100));
    const token2 = makeToken(payload);
    expect(token1).not.toBe(token2);
  }, 10000);

  it('semua field payload tersimpan dalam token', () => {
    const payload = { id: 7, role: 'admin', name: 'Test User', email: 'test@wanar.ai' };
    const token = makeToken(payload);
    const decoded = verifyToken(token);
    expect(decoded).toBeTruthy();
    expect(decoded.id).toBe(7);
    expect(decoded.role).toBe('admin');
    expect(decoded.name).toBe('Test User');
    expect(decoded.email).toBe('test@wanar.ai');
  });
});
