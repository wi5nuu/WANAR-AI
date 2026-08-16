import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { findOrCreateUser, getUserById, getUserTokensToday, recordUserTokens } from './database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'wanar-ai-jwt-secret-change-in-production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const TOKEN_DAILY_LIMIT = parseInt(process.env.USER_TOKEN_DAILY_LIMIT || '10000', 10);

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export async function loginWithGoogle(idToken) {
  if (!googleClient) {
    return { success: false, error: 'Google OAuth not configured (GOOGLE_CLIENT_ID missing)' };
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const profile = {
      google_id: payload.sub,
      name: payload.name,
      email: payload.email,
      avatar: payload.picture,
    };
    const user = findOrCreateUser(profile);
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    return {
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, role: user.role },
    };
  } catch (err) {
    return { success: false, error: 'Invalid Google token: ' + err.message };
  }
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;
  next();
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export async function checkUserTokenLimit(userId, tokensToUse = 0) {
  const used = await getUserTokensToday(userId);
  return (used + tokensToUse) <= TOKEN_DAILY_LIMIT;
}

export function getUserDailyLimit() {
  return TOKEN_DAILY_LIMIT;
}