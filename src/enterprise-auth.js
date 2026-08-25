import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db from './database.js';
import { JWT_SECRET_FINAL as JWT_SECRET } from './auth.js';

/**
 * Enterprise Authentication Module
 * Provides RBAC, team management, API keys, and JWT authentication
 * @module enterprise-auth
 */

const ROLES_HIERARCHY = {
  superadmin: 100,
  admin: 80,
  owner: 90,
  editor: 60,
  member: 40,
  viewer: 20,
  user: 10,
};

const DEFAULT_PERMISSIONS = {
  chat: { create: true, read: true, update: true, delete: false },
  rag: { query: true, reindex: false },
  team: { read: true, update: false, delete: false, invite: false },
  api_keys: { create: false, read: true, delete: false },
  billing: { read: false },
};

/**
 * Checks if a user's role has permission to perform an action requiring a specific role
 * @param {string} userRole - The user's current role
 * @param {string} requiredRole - The minimum role required
 * @returns {boolean} True if user role meets or exceeds required role
 */
export function roleHasPermission(userRole, requiredRole) {
  const userLevel = ROLES_HIERARCHY[userRole] || 0;
  const requiredLevel = ROLES_HIERARCHY[requiredRole] || 0;
  return userLevel >= requiredLevel;
}

/**
 * Checks if a user has the required team permission
 * @param {object} user - User object with id and role
 * @param {number} teamId - Team ID to check membership
 * @param {string} requiredRole - Required role within the team
 * @returns {boolean} True if user has permission, false otherwise
 */
export function checkTeamPermission(user, teamId, requiredRole) {
  if (user.role === 'superadmin') return true;
  const membership = getTeamMember(teamId, user.id);
  if (!membership) return false;
  if (membership.role === 'owner') return true;
  return roleHasPermission(membership.role, requiredRole);
}

/**
 * Generates a new API key with secure random token
 * @param {string} [name=''] - Optional name/description for the API key
 * @returns {object} Object containing raw key, hash, prefix, and name
 */
export function generateApiKey(name = '') {
  const raw = `wanar_${crypto.randomBytes(24).toString('base64url')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix, name };
}

/**
 * Hashes an API key using SHA-256
 * @param {string} raw - Raw API key to hash
 * @returns {string} SHA-256 hex digest
 */
export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Creates a JWT token for a user
 * @param {object} user - User object with id, role, name, email
 * @param {object} [extra={}] - Additional claims to include in token
 * @returns {string} Signed JWT token
 */
export function createToken(user, extra = {}) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email, ...extra },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Verifies a JWT token and returns the decoded payload
 * @param {string} token - JWT token to verify
 * @returns {object|null} Decoded token payload or null if invalid
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Express middleware factory to require specific roles
 * @param {...string} roles - Allowed roles (user must have one of these)
 * @returns {Function} Express middleware
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.role === 'superadmin') return next();
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: `Required role: ${roles.join(' or ')}` });
  };
}

/**
 * Express middleware factory to require specific team role
 * @param {string} requiredRole - Required role within the team
 * @returns {Function} Express middleware
 */
export function requireTeamRole(requiredRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.role === 'superadmin') return next();
    const teamId = parseInt(req.params.teamId || req.body.teamId || req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    if (checkTeamPermission(req.user, teamId, requiredRole)) return next();
    return res.status(403).json({ error: `Insufficient team role. Required: ${requiredRole}` });
  };
}

/**
 * Express middleware for tenant isolation - ensures users can only access their own team's resources
 * @param {string} scope - Scope of isolation ('team' or 'user')
 * @returns {Function} Express middleware
 */
export function tenantIsolation(scope) {
  return (req, res, next) => {
    if (req.user?.role === 'superadmin') return next();
    const teamId = parseInt(req.params.teamId || req.query.teamId);
    if (teamId && req.user.teamIds && !req.user.teamIds.includes(teamId)) {
      return res.status(403).json({ error: 'Access denied to this team' });
    }
    if (scope === 'user' && req.params.userId && req.user.id !== parseInt(req.params.userId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to this user' });
    }
    next();
  };
}

/**
 * Express middleware for authentication - validates JWT or API key
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next function
 * @returns {void}
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization header' });

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
      return next();
    }
  }

  if (authHeader.startsWith('ApiKey ') || authHeader.startsWith('Bearer wanar_')) {
    const rawKey = authHeader.startsWith('ApiKey ') ? authHeader.slice(7) : authHeader.slice(7);
    const apiKey = lookupApiKey(rawKey);
    if (apiKey) {
      req.user = {
        id: apiKey.user_id,
        role: apiKey.role || 'user',
        name: apiKey.user_name || 'API User',
        email: null,
        teamIds: apiKey.team_ids || [],
        apiKeyId: apiKey.id,
        apiKeyName: apiKey.name,
      };
      updateApiKeyLastUsed(apiKey.id);
      return next();
    }
  }

  return res.status(401).json({ error: 'Invalid or expired token' });
}

/**
 * Express middleware for optional authentication - attaches user if valid token provided
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next function
 * @returns {void}
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();

  if (authHeader.startsWith('Bearer ') || authHeader.startsWith('ApiKey ')) {
    const prefix = authHeader.startsWith('Bearer ') ? 7 : 7;
    const value = authHeader.slice(prefix);

    const payload = verifyToken(value);
    if (payload) {
      req.user = payload;
      return next();
    }

    const apiKey = lookupApiKey(value);
    if (apiKey) {
      req.user = {
        id: apiKey.user_id,
        role: apiKey.role || 'user',
        name: apiKey.user_name || 'API User',
        teamIds: apiKey.team_ids || [],
        apiKeyId: apiKey.id,
      };
      updateApiKeyLastUsed(apiKey.id);
      return next();
    }
  }
  next();
}

/**
 * Creates a new team with the user as owner
 * @param {string} name - Team name
 * @param {number} ownerId - User ID of the owner
 * @returns {object} Created team object with id, name, slug, owner_id
 */
export function createTeam(name, ownerId) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + crypto.randomBytes(2).toString('hex');
  const result = db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run(name, slug, ownerId);
  const teamId = result.lastInsertRowid;
  db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').run(teamId, ownerId, 'owner');
  return { id: teamId, name, slug, owner_id: ownerId };
}

/**
 * Gets team details by ID
 * @param {number} teamId - Team ID
 * @returns {object|null} Team object with owner info and member count
 */
export function getTeam(teamId) {
  return db.prepare(`
    SELECT t.*, u.name as owner_name, u.email as owner_email,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t LEFT JOIN users u ON t.owner_id = u.id WHERE t.id = ?
  `).get(teamId);
}

/**
 * Gets all teams a user is a member of
 * @param {number} userId - User ID
 * @returns {Array} Array of team objects with membership role
 */
export function getTeamsByUser(userId) {
  return db.prepare(`
    SELECT t.*, tm.role as membership_role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t JOIN team_members tm ON t.id = tm.team_id
    WHERE tm.user_id = ? ORDER BY t.name
  `).all(userId);
}

/**
 * Updates team name or slug
 * @param {number} teamId - Team ID
 * @param {object} data - Update data (name, slug)
 * @returns {boolean} True if updated, false if no changes
 */
export function updateTeam(teamId, data) {
  const fields = [];
  const values = [];
  if (data.name) { fields.push('name = ?'); values.push(data.name); }
  if (data.slug) { fields.push('slug = ?'); values.push(data.slug); }
  if (fields.length === 0) return false;
  values.push(teamId);
  db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

/**
 * Deletes a team and all associated data
 * @param {number} teamId - Team ID to delete
 * @returns {void}
 */
export function deleteTeam(teamId) {
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM workspaces WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM api_keys WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
}

/**
 * Adds or updates a team member
 * @param {number} teamId - Team ID
 * @param {number} userId - User ID to add
 * @param {string} [role='member'] - Role within team (owner, admin, editor, member, viewer)
 * @returns {object} Result with updated flag and role
 */
export function addTeamMember(teamId, userId, role = 'member') {
  const existing = db.prepare('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  if (existing) {
    db.prepare('UPDATE team_members SET role = ? WHERE id = ?').run(role, existing.id);
    return { updated: true, role };
  }
  db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').run(teamId, userId, role);
  return { updated: false, role };
}

/**
 * Removes a team member (cannot remove owner)
 * @param {number} teamId - Team ID
 * @param {number} userId - User ID to remove
 * @returns {void}
 */
export function removeTeamMember(teamId, userId) {
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role != ?').run(teamId, userId, 'owner');
}

/**
 * Gets all members of a team with their roles
 * @param {number} teamId - Team ID
 * @returns {Array} Array of member objects with user info and team role
 */
export function getTeamMembers(teamId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.avatar, u.role as global_role, tm.role as team_role, tm.joined_at
    FROM team_members tm JOIN users u ON tm.user_id = u.id
    WHERE tm.team_id = ? ORDER BY
      CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
      u.name
  `).all(teamId);
}

/**
 * Gets a specific team member
 * @param {number} teamId - Team ID
 * @param {number} userId - User ID
 * @returns {object|null} Team member object or null if not found
 */
export function getTeamMember(teamId, userId) {
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
}

/**
 * Creates a new workspace within a team
 * @param {number} teamId - Team ID
 * @param {string} name - Workspace name
 * @param {number} createdBy - User ID of creator
 * @returns {object} Created workspace object
 */
export function createWorkspace(teamId, name, createdBy) {
  const result = db.prepare('INSERT INTO workspaces (team_id, name, created_by) VALUES (?, ?, ?)').run(teamId, name, createdBy);
  return { id: result.lastInsertRowid, team_id: teamId, name };
}

/**
 * Gets all workspaces for a team
 * @param {number} teamId - Team ID
 * @returns {Array} Array of workspace objects with session counts
 */
export function getWorkspaces(teamId) {
  return db.prepare(`
    SELECT w.*, u.name as created_by_name,
      (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.workspace_id = w.id) as session_count
    FROM workspaces w LEFT JOIN users u ON w.created_by = u.id
    WHERE w.team_id = ? ORDER BY w.name
  `).all(teamId);
}

/**
 * Deletes a workspace and reassigns its sessions
 * @param {number} workspaceId - Workspace ID to delete
 * @returns {void}
 */
export function deleteWorkspace(workspaceId) {
  db.prepare('UPDATE chat_sessions SET workspace_id = NULL WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
}

/**
 * Creates a new API key for a team
 * @param {number} teamId - Team ID
 * @param {number} userId - User ID creating the key
 * @param {string} name - Key name/description
 * @param {object} [permissions=null] - Custom permissions (uses defaults if null)
 * @returns {object} Object with raw key, prefix, name, teamId
 */
export function createApiKey(teamId, userId, name, permissions = null) {
  const { raw, hash, prefix } = generateApiKey(name);
  const permsJson = permissions ? JSON.stringify(permissions) : JSON.stringify(DEFAULT_PERMISSIONS);
  db.prepare('INSERT INTO api_keys (key_hash, key_prefix, name, team_id, user_id, permissions) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hash, prefix, name, teamId, userId, permsJson);
  return { raw, prefix, name, teamId };
}

/**
 * Gets all API keys for a team
 * @param {number} teamId - Team ID
 * @returns {Array} Array of API key objects with user info and metadata
 */
export function getApiKeys(teamId) {
  return db.prepare(`
    SELECT ak.id, ak.key_prefix, ak.name, ak.team_id, ak.user_id, u.name as user_name,
      ak.permissions, ak.last_used, ak.created_at, ak.is_active
    FROM api_keys ak LEFT JOIN users u ON ak.user_id = u.id
    WHERE ak.team_id = ? ORDER BY ak.created_at DESC
  `).all(teamId);
}

/**
 * Looks up an API key by raw key value
 * @param {string} rawKey - Raw API key to look up
 * @returns {object|null} API key object with user info and team IDs
 */
export function lookupApiKey(rawKey) {
  const hash = hashApiKey(rawKey);
  const row = db.prepare(`
    SELECT ak.*, u.name as user_name, u.role,
      (SELECT json_group_array(tm.team_id) FROM team_members tm WHERE tm.user_id = ak.user_id) as team_ids
    FROM api_keys ak JOIN users u ON ak.user_id = u.id
    WHERE ak.key_hash = ? AND ak.is_active = 1
  `).get(hash);
  if (row) {
    // json_group_array() returns TEXT; parse it so membership checks
    // compare numbers instead of doing substring matches on a string.
    try { row.team_ids = JSON.parse(row.team_ids || '[]'); } catch { row.team_ids = []; }
  }
  return row;
}

/**
 * Updates the last used timestamp for an API key
 * @param {number} apiKeyId - API key ID
 * @returns {void}
 */
export function updateApiKeyLastUsed(apiKeyId) {
  db.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").run(apiKeyId);
}

/**
 * Revokes (deactivates) an API key
 * @param {number} apiKeyId - API key ID
 * @param {number} teamId - Team ID for authorization
 * @returns {void}
 */
export function revokeApiKey(apiKeyId, teamId) {
  db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND team_id = ?').run(apiKeyId, teamId);
}

/**
 * Rotates an API key - generates new key while keeping metadata
 * @param {number} apiKeyId - API key ID
 * @param {number} teamId - Team ID for authorization
 * @param {string} [name] - Optional new name
 * @returns {object|null} New key object with raw key, or null if not found
 */
export function rotateApiKey(apiKeyId, teamId, name) {
  const oldKey = db.prepare('SELECT * FROM api_keys WHERE id = ? AND team_id = ?').get(apiKeyId, teamId);
  if (!oldKey) return null;
  const { raw, hash, prefix } = generateApiKey(name || oldKey.name);
  db.prepare('UPDATE api_keys SET key_hash = ?, key_prefix = ?, is_active = 1 WHERE id = ? AND team_id = ?')
    .run(hash, prefix, apiKeyId, teamId);
  return { raw, prefix, name: name || oldKey.name };
}

/**
 * Gets token usage statistics for a team
 * @param {number} teamId - Team ID
 * @param {number} [days=30] - Number of days to look back
 * @returns {Array} Array of daily usage by provider and model
 */
export function getTeamUsage(teamId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT tu.date, tu.provider, tu.model, SUM(tu.tokens) as tokens, SUM(tu.cost) as cost
    FROM token_usage tu
    JOIN team_members tm ON tu.user_id = tm.user_id
    WHERE tm.team_id = ? AND tu.date >= ?
    GROUP BY tu.date, tu.provider, tu.model ORDER BY tu.date DESC
  `).all(teamId, since);
}

/**
 * Gets summary statistics for a team
 * @param {number} teamId - Team ID
 * @returns {object} Object with member count, workspaces, active keys, 30-day tokens and cost
 */
export function getTeamStats(teamId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM team_members WHERE team_id = ?) as members,
      (SELECT COUNT(*) FROM workspaces WHERE team_id = ?) as workspaces,
      (SELECT COUNT(*) FROM api_keys WHERE team_id = ? AND is_active = 1) as active_keys,
      (SELECT COALESCE(SUM(tu.tokens), 0) FROM token_usage tu
        JOIN team_members tm ON tu.user_id = tm.user_id
        WHERE tm.team_id = ? AND tu.date >= date('now', '-30 days')) as tokens_30d,
      (SELECT COALESCE(SUM(tu.cost), 0) FROM token_usage tu
        JOIN team_members tm ON tu.user_id = tm.user_id
        WHERE tm.team_id = ? AND tu.date >= date('now', '-30 days')) as cost_30d
  `).get(teamId, teamId, teamId, teamId, teamId);
}
