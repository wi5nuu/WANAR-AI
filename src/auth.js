import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { findOrCreateUser, getUserById, getUserTokensToday, recordUserTokens } from './database.js';

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const TOKEN_DAILY_LIMIT = parseInt(process.env.USER_TOKEN_DAILY_LIMIT || '10000', 10);

if (!JWT_SECRET) {
  console.error('CRITICAL: JWT_SECRET is not set in environment variables');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production environment');
  }
  console.warn('Using default JWT_SECRET for development only');
}

const JWT_SECRET_FINAL = JWT_SECRET || 'wanar-ai-jwt-secret-dev-only-insecure';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/**
 * Authenticates a user with Google OAuth and returns a JWT token
 * @param {string} idToken - Google ID token from client-side authentication
 * @returns {Promise<{success: boolean, token?: string, user?: object, error?: string}>} Authentication result
 */
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
      JWT_SECRET_FINAL,
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

/**
 * Verifies a JWT token and returns the decoded payload
 * @param {string} token - JWT token to verify
 * @returns {object|null} Decoded token payload or null if invalid
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET_FINAL);
  } catch {
    return null;
  }
}

/**
 * Express middleware to verify JWT token and attach user payload to request
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
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

/**
 * Express middleware to restrict access to admin users only
 * @param {object} req - Express request object with user payload
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Checks if a user has exceeded their daily token usage limit
 * @param {number} userId - User ID to check
 * @param {number} [tokensToUse=0] - Number of tokens about to be used
 * @returns {Promise<boolean>} True if user is within limit, false if limit exceeded
 */
export async function checkUserTokenLimit(userId, tokensToUse = 0) {
  const used = await getUserTokensToday(userId);
  return (used + tokensToUse) <= TOKEN_DAILY_LIMIT;
}

/**
 * Gets the configured daily token limit for users
 * @returns {number} Daily token limit
 */
export function getUserDailyLimit() {
  return TOKEN_DAILY_LIMIT;
}