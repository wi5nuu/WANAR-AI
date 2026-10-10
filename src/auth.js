import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { findOrCreateUser, getUserById, getUserTokensToday, recordUserTokens } from './database.js';

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const TOKEN_DAILY_LIMIT = parseInt(process.env.USER_TOKEN_DAILY_LIMIT || '10000', 10);

/**
 * The only HMAC algorithm we accept. Pinning this prevents "algorithm
 * confusion": an attacker who can craft a token must not be able to downgrade
 * to `none`, or trick a future asymmetric setup into verifying an HS256 token
 * against a public key.
 */
export const JWT_ALGORITHM = 'HS256';

/**
 * Minimum secret length. HS256's security is bounded by the secret's entropy;
 * a short secret is brute-forceable offline from a single captured token.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Values that ship in .env.example or appear in public writeups. Any of these
 * is treated as "not configured", because they are known to every reader of the
 * repository and therefore provide zero security.
 */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'wanar-ai-jwt-secret-dev-only-insecure',
  'changeme',
  'secret',
  'your-secret-here',
]);

function assertUsableSecret(secret) {
  const fail = (why) => {
    throw new Error(
      `FATAL: ${why} Refusing to start. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"\n` +
        `then set JWT_SECRET in your .env (and rotate it if it was ever exposed).`
    );
  };

  if (!secret) fail('JWT_SECRET is not set.');
  if (secret.length < MIN_SECRET_LENGTH) {
    fail(`JWT_SECRET is too short (${secret.length} chars, need >= ${MIN_SECRET_LENGTH}).`);
  }
  if (PLACEHOLDER_SECRETS.has(secret.trim().toLowerCase())) {
    fail('JWT_SECRET is still the public example value, so anyone can forge tokens.');
  }
}

// Uses this in tests to opt into a deterministic secret explicitly rather than
// relying on an insecure implicit fallback.
if (process.env.NODE_ENV !== 'test') {
  assertUsableSecret(JWT_SECRET);
}

/**
 * In production the secret must be explicitly configured. In test only, a fixed
 * value is permitted so suites are deterministic — but it is never accepted
 * implicitly in a real deployment.
 */
export const JWT_SECRET_FINAL =
  JWT_SECRET || (process.env.NODE_ENV === 'test' ? 'test-only-jwt-secret-not-for-production-use' : '');

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
      { algorithm: JWT_ALGORITHM, expiresIn: '7d' }
    );
    return {
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, role: user.role },
    };
  } catch (err) {
    // Do not echo library internals back to the caller: verification error
    // strings can leak whether a token was malformed vs. signed with a wrong
    // key, which is useful reconnaissance.
    console.warn('[AUTH] Google token verification failed:', err.message);
    return { success: false, error: 'Invalid or expired Google token' };
  }
}

/**
 * Verifies a JWT token and returns the decoded payload
 * @param {string} token - JWT token to verify
 * @returns {object|null} Decoded token payload or null if invalid
 */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    // `algorithms` is pinned: without it, a token whose header claims a
    // different algorithm can be accepted in certain library configurations.
    return jwt.verify(token, JWT_SECRET_FINAL, { algorithms: [JWT_ALGORITHM] });
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
  const userId = req.user?.id;
  if (!userId) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Re-read the role from the database instead of trusting the token's claim.
  // A JWT stays valid for its entire lifetime (7d), so if an admin is demoted or
  // an account is deleted, a token-only check would keep granting access until
  // it expired. The DB is the source of truth.
  let user;
  try {
    user = getUserById(userId);
  } catch {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  req.user = { ...req.user, role: user.role };
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