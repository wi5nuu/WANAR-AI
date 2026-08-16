import db from '../src/database.js';
import crypto from 'crypto';

// Create admin user
const adminKey = 'wanar_' + crypto.randomBytes(16).toString('hex');
const admin = db.prepare('INSERT OR IGNORE INTO users (google_id, name, email, role, api_key) VALUES (?, ?, ?, ?, ?)')
  .run('admin_test', 'Super Admin', 'admin@wanar.ai', 'superadmin', adminKey);

const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@wanar.ai');
console.log(JSON.stringify({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  api_key: user.api_key,
}));
