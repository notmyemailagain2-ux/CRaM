/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load settings from a local .env file if one exists (Node 20.12+ built-in).
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file: fall back to real environment variables / defaults.
}

const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // undefined = all interfaces
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || 'crm.db');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
const JWT_SECRET = loadSecret('JWT_SECRET', '.jwt-secret', 'login secret');
// Encrypts two-factor secrets at rest. Back this file up with the database.
const DATA_KEY = crypto.createHash('sha256').update(loadSecret('DATA_KEY', '.data-key', 'data encryption key')).digest();
const SESSION_COOKIE = 'cram_session';
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const APP_NAME = 'CRaM';
let SETUP_CODE = null; // set on first run, cleared once the admin exists

function loadSecret(envName, fileName, label) {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (fromEnv) console.warn(`[warn] ${envName} is shorter than 32 characters; using ${fileName} instead.`);
  // Generate a strong secret once and keep it on disk so it survives restarts.
  const secretFile = path.join(__dirname, fileName);
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // File does not exist yet.
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  console.log(`[info] Generated a new ${label} in ${fileName} (keep this file private and backed up).`);
  return secret;
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------
const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'letmein', 'welcome',
  'admin', 'administrator', 'login', 'iloveyou', 'monkey', 'dragon', 'master', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'batman', 'trustno', 'abc', 'abcd', 'abcdef', 'changeme',
  'secret', 'shadow', 'michael', 'jennifer', 'hello', 'freedom', 'whatever', 'starwars', 'cram', 'mor',
  'company', 'summer', 'winter', 'spring', 'autumn', 'fall', 'test', 'guest', 'default', 'user',
]);

function passwordProblems(pw, { email = '', name = '' } = {}) {
  const problems = [];
  if (typeof pw !== 'string') return ['Password is required.'];
  if (pw.length < 8) problems.push('at least 8 characters');
  if (Buffer.byteLength(pw, 'utf8') > 72) problems.push('no more than 72 characters');
  if (!/[a-z]/.test(pw)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) problems.push('a symbol (e.g. ! @ # $ %)');
  if (/(.)\1\1/.test(pw)) problems.push('no character repeated 3+ times in a row');
  const core = pw.toLowerCase().replace(/[^a-z]/g, '');
  if (COMMON_PASSWORDS.has(core) || /^(.)\1*$/.test(core) || /1234|abcd|qwer/.test(pw.toLowerCase())) {
    problems.push('not a common or predictable password');
  }
  const lower = pw.toLowerCase();
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 3 && lower.includes(local)) problems.push('not contain your email');
  for (const part of String(name).toLowerCase().split(/\s+/)) {
    if (part.length >= 3 && lower.includes(part)) { problems.push('not contain your name'); break; }
  }
  return problems;
}

function assertStrongPassword(pw, context) {
  const problems = passwordProblems(pw, context);
  if (problems.length) throw new ValidationError(`Password must have ${problems.join(', ')}.`);
}

// ---------------------------------------------------------------------------
// Encryption & two-factor (TOTP, RFC 6238 — works with any authenticator app)
// ---------------------------------------------------------------------------
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; value &= (1 << bits) - 1; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of str.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}

function hotp(secretB32, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Returns the matched time step, or null. Rejects codes already used (replay).
function verifyTotp(secretB32, code, lastStep = 0) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secretB32, step)), Buffer.from(clean))) return step;
  }
  return null;
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

// Consumes a recovery code if valid. Returns true/false.
function useRecoveryCode(user, code) {
  const hashes = JSON.parse(user.recovery_codes || '[]');
  const idx = hashes.indexOf(hashCode(code));
  if (!code || idx === -1) return false;
  hashes.splice(idx, 1);
  db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
  return true;
}

// ---------------------------------------------------------------------------
// Allowed values (kept in one place so the UI and API always agree)
// ---------------------------------------------------------------------------
const CUSTOMER_STATUSES = ['active', 'inactive'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const PRIORITIES = ['low', 'medium', 'high'];
const DEAL_STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed-won', 'closed-lost'];
const ACTIVITY_TYPES = ['Call', 'Email', 'Meeting', 'Demo', 'Follow-up', 'Note'];
const ROLES = ['user', 'admin'];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');   // better concurrency for multiple users
db.exec('PRAGMA busy_timeout = 5000');  // wait instead of failing when busy

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    industry TEXT,
    website TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    postal_code TEXT,
    annual_revenue TEXT,
    employee_count TEXT,
    description TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    contact_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    position TEXT,
    source TEXT,
    status TEXT DEFAULT 'new',
    priority TEXT DEFAULT 'medium',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id)
  );

  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    lead_id INTEGER,
    deal_name TEXT NOT NULL,
    value TEXT,
    currency TEXT DEFAULT 'USD',
    stage TEXT DEFAULT 'prospecting',
    probability INTEGER DEFAULT 0,
    expected_close_date DATE,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id),
    FOREIGN KEY (lead_id) REFERENCES leads (id)
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    lead_id INTEGER,
    deal_id INTEGER,
    user_id INTEGER,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT,
    date_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id),
    FOREIGN KEY (lead_id) REFERENCES leads (id),
    FOREIGN KEY (deal_id) REFERENCES deals (id),
    FOREIGN KEY (user_id) REFERENCES users (id)
  );
`);

runMigrations();
ensureAdminUser();

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function runMigrations() {
  // Users can be deactivated (keeps their activity history) and sessions revoked.
  if (!columnExists('users', 'active')) {
    db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }
  if (!columnExists('users', 'token_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
  // Two-factor authentication, recovery codes and lockout.
  const newUserColumns = {
    totp_secret: 'TEXT', totp_pending: 'TEXT', totp_enabled: 'INTEGER NOT NULL DEFAULT 0',
    totp_last_step: 'INTEGER NOT NULL DEFAULT 0', recovery_codes: 'TEXT',
    failed_logins: 'INTEGER NOT NULL DEFAULT 0', locked_until: 'INTEGER NOT NULL DEFAULT 0',
    last_login_at: 'DATETIME',
  };
  for (const [col, type] of Object.entries(newUserColumns)) {
    if (!columnExists('users', col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }

  // Deal values used to be stored as text like "$150,000"; store plain numbers.
  db.exec(`
    UPDATE deals
       SET value = REPLACE(REPLACE(REPLACE(value, '$', ''), ',', ''), ' ', '')
     WHERE value LIKE '%$%' OR value LIKE '%,%' OR value LIKE '% %'
  `);
  // Empty strings saved by the old forms become NULL so joins/filters behave.
  db.exec(`UPDATE activities SET date_time = created_at WHERE date_time IS NULL OR date_time = ''`);
  for (const [table, col] of [['leads', 'customer_id'], ['deals', 'customer_id'], ['deals', 'lead_id'],
    ['activities', 'customer_id'], ['activities', 'lead_id'], ['activities', 'deal_id']]) {
    db.exec(`UPDATE ${table} SET ${col} = NULL WHERE ${col} = ''`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads (customer_id);
    CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals (customer_id);
    CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities (customer_id);
    CREATE INDEX IF NOT EXISTS idx_activities_date ON activities (date_time);
  `);
}

// First run: no accounts exist. The first admin is created in the browser, but
// only by someone who can see this one-time setup code in the server terminal.
function ensureAdminUser() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return;
  SETUP_CODE = base32Encode(crypto.randomBytes(10)).slice(0, 12).replace(/(.{4})(?=.)/g, '$1-');
  console.log('------------------------------------------------------------');
  console.log(` ${APP_NAME} first-time setup`);
  console.log(' Open the app in your browser and create the administrator account.');
  console.log(`   Setup code: ${SETUP_CODE}`);
  console.log('------------------------------------------------------------');
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function cleanText(value, label, { required = false, max = 255 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${label} is invalid.`);
  }
  const text = String(value).trim();
  if (!text) {
    if (required) throw new ValidationError(`${label} is required.`);
    return null;
  }
  if (text.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function cleanEnum(value, label, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function cleanEmail(value, label = 'Email', opts = {}) {
  const email = cleanText(value, label, { max: 254, ...opts });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError(`${label} is not a valid email address.`);
  }
  return email ? email.toLowerCase() : null;
}

function cleanUrl(value, label = 'Website') {
  let url = cleanText(value, label, { max: 500 });
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw new ValidationError(`${label} is not a valid web address.`);
  }
}

function cleanMoney(value, label = 'Value') {
  const text = cleanText(value, label, { max: 30 });
  if (!text) return null;
  const numeric = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(numeric)) {
    throw new ValidationError(`${label} must be a dollar amount, for example 50000 or $50,000.`);
  }
  return String(Number(numeric));
}

function cleanInt(value, label, { min, max, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new ValidationError(`${label} must be a whole number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}.`);
  }
  return n;
}

function cleanDate(value, label) {
  const text = cleanText(value, label, { max: 10 });
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ValidationError(`${label} must be a valid date.`);
  }
  return text;
}

// Stored as "YYYY-MM-DD HH:MM:SS" in UTC, the same format SQLite's CURRENT_TIMESTAMP uses.
function cleanDateTime(value, label) {
  const text = cleanText(value, label, { max: 40 });
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} must be a valid date and time.`);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function cleanRef(value, label, table) {
  const id = cleanInt(value, label, { min: 1 });
  if (id === null) return null;
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) {
    throw new ValidationError(`The selected ${label.toLowerCase()} no longer exists. Refresh and try again.`);
  }
  return id;
}

function parseId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('Invalid record id.');
  return id;
}

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

// ---------------------------------------------------------------------------
// Record schemas: turn a request body into clean column values
// ---------------------------------------------------------------------------
const schemas = {
  customers(b) {
    return {
      company_name: cleanText(b.company_name, 'Company name', { required: true, max: 200 }),
      industry: cleanText(b.industry, 'Industry', { max: 100 }),
      website: cleanUrl(b.website),
      phone: cleanText(b.phone, 'Phone', { max: 50 }),
      email: cleanEmail(b.email),
      address: cleanText(b.address, 'Address', { max: 300 }),
      city: cleanText(b.city, 'City', { max: 100 }),
      state: cleanText(b.state, 'State', { max: 100 }),
      country: cleanText(b.country, 'Country', { max: 100 }),
      postal_code: cleanText(b.postal_code, 'Postal code', { max: 20 }),
      annual_revenue: cleanText(b.annual_revenue, 'Annual revenue', { max: 50 }),
      employee_count: cleanText(b.employee_count, 'Employee count', { max: 50 }),
      description: cleanText(b.description, 'Description', { max: 5000 }),
      status: cleanEnum(b.status, 'Status', CUSTOMER_STATUSES, 'active'),
    };
  },
  leads(b) {
    return {
      customer_id: cleanRef(b.customer_id, 'Customer', 'customers'),
      contact_name: cleanText(b.contact_name, 'Contact name', { required: true, max: 200 }),
      email: cleanEmail(b.email),
      phone: cleanText(b.phone, 'Phone', { max: 50 }),
      position: cleanText(b.position, 'Position', { max: 100 }),
      source: cleanText(b.source, 'Source', { max: 100 }),
      status: cleanEnum(b.status, 'Status', LEAD_STATUSES, 'new'),
      priority: cleanEnum(b.priority, 'Priority', PRIORITIES, 'medium'),
      notes: cleanText(b.notes, 'Notes', { max: 5000 }),
    };
  },
  deals(b) {
    return {
      customer_id: cleanRef(b.customer_id, 'Customer', 'customers'),
      lead_id: cleanRef(b.lead_id, 'Lead', 'leads'),
      deal_name: cleanText(b.deal_name, 'Deal name', { required: true, max: 200 }),
      value: cleanMoney(b.value),
      currency: 'USD',
      stage: cleanEnum(b.stage, 'Stage', DEAL_STAGES, 'prospecting'),
      probability: cleanInt(b.probability, 'Probability', { min: 0, max: 100, fallback: 0 }),
      expected_close_date: cleanDate(b.expected_close_date, 'Expected close date'),
      description: cleanText(b.description, 'Description', { max: 5000 }),
    };
  },
  activities(b) {
    return {
      customer_id: cleanRef(b.customer_id, 'Customer', 'customers'),
      lead_id: cleanRef(b.lead_id, 'Lead', 'leads'),
      deal_id: cleanRef(b.deal_id, 'Deal', 'deals'),
      type: cleanEnum(b.type, 'Activity type', ACTIVITY_TYPES, null) ?? (() => { throw new ValidationError('Activity type is required.'); })(),
      subject: cleanText(b.subject, 'Subject', { required: true, max: 200 }),
      description: cleanText(b.description, 'Description', { max: 5000 }),
      date_time: cleanDateTime(b.date_time, 'Date & time'),
    };
  },
};

function insertRecord(table, values) {
  const cols = Object.keys(values);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return Number(db.prepare(sql).run(...Object.values(values)).lastInsertRowid);
}

function updateRecord(table, id, values, { touch = true } = {}) {
  const cols = Object.keys(values);
  const sets = cols.map((c) => `${c} = ?`);
  if (touch) sets.push('updated_at = CURRENT_TIMESTAMP');
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`;
  return db.prepare(sql).run(...Object.values(values), id).changes;
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// App & middleware
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // All scripts, styles and fonts are served from this server.
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      // Don't force https on plain-http LAN/localhost use; Cloudflare handles https.
      'upgrade-insecure-requests': null,
    },
  },
}));

app.use(express.json({ limit: '100kb' }));

// Self-hosted front-end libraries (no third-party CDNs at runtime).
const vendor = (pkgPath) => path.join(__dirname, 'node_modules', pkgPath);
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(vendor('chart.js/dist/chart.umd.js')));
app.use('/vendor/fontawesome/css', express.static(vendor('@fortawesome/fontawesome-free/css'), { maxAge: '7d' }));
app.use('/vendor/fontawesome/webfonts', express.static(vendor('@fortawesome/fontawesome-free/webfonts'), { maxAge: '30d' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 2000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});
// Separate failure budgets per step (per IP), on top of the per-account lockout.
const authLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many failed attempts from this network. Please wait 15 minutes and try again.' },
});
const loginLimiter = authLimiter();
const mfaLimiter = authLimiter();
const recoverLimiter = authLimiter();
const setupLimiter = authLimiter();
app.use('/api/', apiLimiter);

// CRM data must never be cached by browsers or by Cloudflare.
// Changes must carry a custom header, which other websites cannot send (CSRF protection).
app.use('/api/', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'CRaM') {
    return res.status(403).json({ error: 'Request blocked for security reasons. Refresh the page and try again.' });
  }
  next();
});

// Wrap a route so thrown errors reach the error handler instead of crashing.
const route = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active,
    totp_enabled: !!u.totp_enabled, created_at: u.created_at, last_login_at: u.last_login_at,
    recovery_codes_left: JSON.parse(u.recovery_codes || '[]').length,
  };
}

// ---- Sessions: signed token in an httpOnly cookie (page scripts can't read it) ----
// stage: 'mfa'    = password OK, waiting for authenticator code
//        'enroll' = password OK, must set up two-factor before continuing
//        'full'   = fully signed in
const STAGE_TTL = { mfa: '5m', enroll: '15m', full: JWT_EXPIRES_IN };

function setSession(req, res, user, stage) {
  const token = jwt.sign({ id: user.id, tv: user.token_version, stage }, JWT_SECRET, { expiresIn: STAGE_TTL[stage] });
  const decoded = jwt.decode(token);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/',
    maxAge: (decoded.exp - decoded.iat) * 1000,
  });
}

function clearSession(req, res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function loadSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user || !user.active || user.token_version !== payload.tv) return null;
    return { user, stage: payload.stage };
  } catch {
    return null;
  }
}

// Requires a session at one of the given stages (default: fully signed in).
const requireSession = (...stages) => (req, res, next) => {
  const allowed = stages.length ? stages : ['full'];
  const session = loadSession(req);
  if (!session || !allowed.includes(session.stage)) {
    return res.status(401).json({ error: 'Please sign in.' });
  }
  req.user = session.user;
  req.stage = session.stage;
  next();
};
const authenticate = requireSession('full');

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only administrators can do that.' });
  next();
}

function revokeSessions(userId) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
}

const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// Lockout bookkeeping
function isLocked(user) {
  return user.locked_until && user.locked_until > Date.now();
}
function recordFailure(user) {
  const fails = (user.failed_logins || 0) + 1;
  const lockedUntil = fails >= MAX_FAILED_LOGINS ? Date.now() + LOCKOUT_MINUTES * 60000 : 0;
  db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
    .run(lockedUntil ? 0 : fails, lockedUntil, user.id);
  if (lockedUntil) console.warn(`[security] ${user.email} locked for ${LOCKOUT_MINUTES} minutes after ${MAX_FAILED_LOGINS} failed attempts.`);
}
function recordSuccess(user) {
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0, last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
}
const LOCKED_MSG = `Too many failed attempts. This account is locked for ${LOCKOUT_MINUTES} minutes.`;

// Constant-time-ish dummy hash so unknown emails take as long as real ones.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// ---------------------------------------------------------------------------
// First-time setup (only while no accounts exist)
// ---------------------------------------------------------------------------
app.get('/api/setup/status', (req, res) => {
  res.json({ needsSetup: SETUP_CODE !== null, appName: APP_NAME });
});

app.post('/api/setup', setupLimiter, route(async (req, res) => {
  if (SETUP_CODE === null) return res.status(403).json({ error: 'Setup has already been completed.' });
  const b = body(req);
  const code = String(b.setup_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const expected = SETUP_CODE.replace(/-/g, '');
  if (code.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
    throw new ValidationError('The setup code is incorrect. Check the server terminal.');
  }
  const name = cleanText(b.name, 'Name', { required: true, max: 100 });
  const email = cleanEmail(b.email, 'Email', { required: true });
  assertStrongPassword(b.password, { email, name });
  const id = insertRecord('users', { email, password: await bcrypt.hash(b.password, 12), name, role: 'admin' });
  SETUP_CODE = null;
  console.log(`[info] Administrator account created for ${email}.`);
  setSession(req, res, getUser(id), 'enroll');
  res.status(201).json({ stage: 'enroll' });
}));

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, route(async (req, res) => {
  const { email, password } = body(req);
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
  const valid = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
  if (user && isLocked(user)) return res.status(429).json({ error: LOCKED_MSG });
  if (!user || !user.active || !valid) {
    if (user && user.active) recordFailure(user);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const stage = user.totp_enabled ? 'mfa' : 'enroll';
  if (stage === 'enroll') recordSuccess(user);
  setSession(req, res, user, stage);
  res.json({ stage });
}));

// Second step: authenticator code OR a one-time recovery code.
app.post('/api/auth/mfa', mfaLimiter, requireSession('mfa'), route((req, res) => {
  const user = req.user;
  if (isLocked(user)) return res.status(429).json({ error: LOCKED_MSG });
  const { code } = body(req);
  const step = user.totp_secret ? verifyTotp(decrypt(user.totp_secret), code, user.totp_last_step) : null;
  let usedRecovery = false;
  if (step) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  } else if (useRecoveryCode(user, code)) {
    usedRecovery = true;
  } else {
    recordFailure(user);
    return res.status(401).json({ error: 'That code is incorrect or has expired.' });
  }
  recordSuccess(user);
  setSession(req, res, getUser(user.id), 'full');
  const left = JSON.parse(getUser(user.id).recovery_codes || '[]').length;
  res.json({ stage: 'full', usedRecovery, recoveryCodesLeft: left });
}));

app.get('/api/auth/me', requireSession('full', 'enroll'), (req, res) => {
  res.json({ user: publicUser(req.user), stage: req.stage });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ message: 'Signed out.' });
});

// ---------------------------------------------------------------------------
// Two-factor setup
// ---------------------------------------------------------------------------
app.post('/api/auth/2fa/setup', requireSession('enroll', 'full'), route(async (req, res) => {
  if (req.user.totp_enabled) throw new ValidationError('Two-factor authentication is already on.');
  const secret = base32Encode(crypto.randomBytes(20));
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(encrypt(secret), req.user.id);
  const label = encodeURIComponent(`${APP_NAME}:${req.user.email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(APP_NAME)}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  res.json({ secret: secret.replace(/(.{4})(?=.)/g, '$1 '), qr });
}));

app.post('/api/auth/2fa/enable', requireSession('enroll', 'full'), route((req, res) => {
  const user = req.user;
  if (!user.totp_pending) throw new ValidationError('Start two-factor setup first.');
  const secret = decrypt(user.totp_pending);
  const step = verifyTotp(secret, body(req).code, 0);
  if (!step) throw new ValidationError('That code is incorrect. Check your authenticator app and try again.');
  const { codes, hashes } = newRecoveryCodes();
  db.prepare(`UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?,
              recovery_codes = ? WHERE id = ?`).run(encrypt(secret), step, JSON.stringify(hashes), user.id);
  recordSuccess(user);
  setSession(req, res, getUser(user.id), 'full');
  res.json({ stage: 'full', recoveryCodes: codes });
}));

app.post('/api/auth/recovery-codes', authenticate, route(async (req, res) => {
  const { password } = body(req);
  if (typeof password !== 'string' || !(await bcrypt.compare(password, req.user.password))) {
    throw new ValidationError('Your password is incorrect.');
  }
  const { codes, hashes } = newRecoveryCodes();
  db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), req.user.id);
  res.json({ recoveryCodes: codes });
}));

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
app.post('/api/auth/change-password', authenticate, route(async (req, res) => {
  const { current_password, new_password } = body(req);
  if (typeof current_password !== 'string' || !(await bcrypt.compare(current_password, req.user.password))) {
    throw new ValidationError('Your current password is incorrect.');
  }
  assertStrongPassword(new_password, req.user);
  if (await bcrypt.compare(new_password, req.user.password)) {
    throw new ValidationError('Choose a password different from your current one.');
  }
  db.prepare('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?')
    .run(await bcrypt.hash(new_password, 12), req.user.id);
  setSession(req, res, getUser(req.user.id), 'full'); // other devices are signed out
  res.json({ message: 'Password changed.' });
}));

// Forgot password: recovery code + authenticator code proves it's really them.
app.post('/api/auth/recover', recoverLimiter, route(async (req, res) => {
  const { email, recovery_code, totp_code, new_password } = body(req);
  const generic = 'Those details could not be verified. Check them and try again, or ask an administrator to reset your password.';
  if (typeof email !== 'string' || !email.trim()) throw new ValidationError(generic);
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
  if (!user || !user.active || !user.totp_enabled) throw new ValidationError(generic);
  if (isLocked(user)) return res.status(429).json({ error: LOCKED_MSG });

  const step = verifyTotp(decrypt(user.totp_secret), totp_code, user.totp_last_step);
  const hashes = JSON.parse(user.recovery_codes || '[]');
  if (!step || !hashes.includes(hashCode(recovery_code || ''))) {
    recordFailure(user);
    throw new ValidationError(generic);
  }
  assertStrongPassword(new_password, user); // checked before consuming the code
  useRecoveryCode(user, recovery_code);
  db.prepare(`UPDATE users SET password = ?, totp_last_step = ?, token_version = token_version + 1,
              failed_logins = 0, locked_until = 0 WHERE id = ?`).run(await bcrypt.hash(new_password, 12), step, user.id);
  console.log(`[security] ${user.email} reset their password with a recovery code.`);
  res.json({ message: 'Password reset. You can now sign in with your new password.' });
}));

// ---------------------------------------------------------------------------
// Team members (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', authenticate, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all().map(publicUser));
});

app.post('/api/users', authenticate, requireAdmin, route(async (req, res) => {
  const b = body(req);
  const name = cleanText(b.name, 'Name', { required: true, max: 100 });
  const email = cleanEmail(b.email, 'Email', { required: true });
  const role = cleanEnum(b.role, 'Role', ROLES, 'user');
  assertStrongPassword(b.password, { email, name });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
    throw new ValidationError('A team member with that email already exists.');
  }
  const id = insertRecord('users', { email, password: await bcrypt.hash(b.password, 12), name, role });
  console.log(`[security] ${req.user.email} added team member ${email} (${role}).`);
  res.status(201).json({ id, message: 'Team member added. They will set up two-factor authentication at first sign-in.' });
}));

app.put('/api/users/:id', authenticate, requireAdmin, route(async (req, res) => {
  const id = parseId(req);
  const b = body(req);
  const user = getUser(id);
  if (!user) return res.status(404).json({ error: 'Team member not found.' });

  const name = cleanText(b.name, 'Name', { required: true, max: 100 });
  const role = cleanEnum(b.role, 'Role', ROLES, user.role);
  const active = b.active === undefined ? !!user.active : !!b.active;
  const reset2fa = !!b.reset_2fa;

  if (id === req.user.id && (role !== 'admin' || !active || reset2fa)) {
    throw new ValidationError("You can't remove your own admin access, deactivate yourself, or reset your own two-factor here.");
  }

  const values = { name, role, active: active ? 1 : 0 };
  let revoke = active !== !!user.active || role !== user.role;
  if (b.password) {
    assertStrongPassword(b.password, { email: user.email, name });
    values.password = await bcrypt.hash(b.password, 12);
    values.failed_logins = 0;
    values.locked_until = 0;
    revoke = true;
  }
  if (reset2fa) {
    Object.assign(values, { totp_secret: null, totp_pending: null, totp_enabled: 0, totp_last_step: 0, recovery_codes: null });
    revoke = true;
  }
  updateRecord('users', id, values, { touch: false });
  if (revoke) revokeSessions(id);
  console.log(`[security] ${req.user.email} updated team member ${user.email}${b.password ? ' (password reset)' : ''}${reset2fa ? ' (2FA reset)' : ''}.`);
  res.json({ message: 'Team member updated.' });
}));

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
app.get('/api/dashboard', authenticate, (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  const stats = {
    totalCustomers: one(`SELECT COUNT(*) AS n FROM customers WHERE status = 'active'`).n,
    activeLeads: one(`SELECT COUNT(*) AS n FROM leads WHERE status NOT IN ('converted', 'lost')`).n,
    openDeals: one(`SELECT COUNT(*) AS n FROM deals WHERE stage NOT IN ('closed-won', 'closed-lost')`).n,
    pipelineValue: one(`SELECT COALESCE(SUM(CAST(value AS REAL)), 0) AS n FROM deals WHERE stage NOT IN ('closed-won', 'closed-lost')`).n,
    wonValue: one(`SELECT COALESCE(SUM(CAST(value AS REAL)), 0) AS n FROM deals WHERE stage = 'closed-won'`).n,
  };

  const stageCounts = Object.fromEntries(
    db.prepare('SELECT stage, COUNT(*) AS count FROM deals GROUP BY stage').all().map((r) => [r.stage, r.count]));
  const statusCounts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS count FROM leads GROUP BY status').all().map((r) => [r.status, r.count]));

  res.json({
    stats,
    dealsByStage: DEAL_STAGES.map((stage) => ({ stage, count: stageCounts[stage] || 0 })),
    leadsByStatus: LEAD_STATUSES.map((status) => ({ status, count: statusCounts[status] || 0 })),
    recentActivities: db.prepare(`
      SELECT a.*, c.company_name, u.name AS user_name
        FROM activities a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.date_time DESC, a.id DESC
       LIMIT 5`).all(),
  });
});

// Allowed values for drop-downs, so the UI never drifts from the API.
app.get('/api/options', authenticate, (req, res) => {
  res.json({
    customerStatuses: CUSTOMER_STATUSES,
    leadStatuses: LEAD_STATUSES,
    priorities: PRIORITIES,
    dealStages: DEAL_STAGES,
    activityTypes: ACTIVITY_TYPES,
    industries: db.prepare(`SELECT DISTINCT industry FROM customers WHERE industry IS NOT NULL AND industry <> '' ORDER BY industry`)
      .all().map((r) => r.industry),
  });
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
app.get('/api/customers', authenticate, (req, res) => {
  const { search, status, industry } = req.query;
  let sql = 'SELECT * FROM customers WHERE 1=1';
  const params = [];
  if (typeof search === 'string' && search.trim()) {
    sql += ' AND (company_name LIKE ? OR email LIKE ? OR phone LIKE ?)';
    const like = `%${search.trim()}%`;
    params.push(like, like, like);
  }
  if (typeof status === 'string' && status) { sql += ' AND status = ?'; params.push(status); }
  if (typeof industry === 'string' && industry) { sql += ' AND industry = ?'; params.push(industry); }
  sql += ' ORDER BY company_name COLLATE NOCASE';
  res.json(db.prepare(sql).all(...params));
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
app.get('/api/leads', authenticate, (req, res) => {
  const { customer_id, status, priority, search } = req.query;
  let sql = 'SELECT l.*, c.company_name FROM leads l LEFT JOIN customers c ON l.customer_id = c.id WHERE 1=1';
  const params = [];
  if (customer_id) { sql += ' AND l.customer_id = ?'; params.push(Number(customer_id)); }
  if (typeof status === 'string' && status) { sql += ' AND l.status = ?'; params.push(status); }
  if (typeof priority === 'string' && priority) { sql += ' AND l.priority = ?'; params.push(priority); }
  if (typeof search === 'string' && search.trim()) {
    sql += ' AND (l.contact_name LIKE ? OR l.email LIKE ? OR c.company_name LIKE ?)';
    const like = `%${search.trim()}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY l.created_at DESC, l.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------
app.get('/api/deals', authenticate, (req, res) => {
  const { stage, customer_id, search } = req.query;
  let sql = 'SELECT d.*, c.company_name FROM deals d LEFT JOIN customers c ON d.customer_id = c.id WHERE 1=1';
  const params = [];
  if (typeof stage === 'string' && stage) { sql += ' AND d.stage = ?'; params.push(stage); }
  if (customer_id) { sql += ' AND d.customer_id = ?'; params.push(Number(customer_id)); }
  if (typeof search === 'string' && search.trim()) {
    sql += ' AND (d.deal_name LIKE ? OR c.company_name LIKE ?)';
    const like = `%${search.trim()}%`;
    params.push(like, like);
  }
  sql += ' ORDER BY d.created_at DESC, d.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------
app.get('/api/activities', authenticate, (req, res) => {
  const { customer_id, type } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  let sql = `
    SELECT a.*, u.name AS user_name, c.company_name
      FROM activities a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN customers c ON a.customer_id = c.id
     WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ' AND a.customer_id = ?'; params.push(Number(customer_id)); }
  if (typeof type === 'string' && type) { sql += ' AND a.type = ?'; params.push(type); }
  sql += ' ORDER BY a.date_time DESC, a.id DESC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// ---------------------------------------------------------------------------
// Shared create / read / update / delete for all four record types
// ---------------------------------------------------------------------------
const labels = { customers: 'Customer', leads: 'Lead', deals: 'Deal', activities: 'Activity' };

// What to unlink when a record is deleted, so nothing points at a missing row.
const unlinkOnDelete = {
  customers: [['leads', 'customer_id'], ['deals', 'customer_id'], ['activities', 'customer_id']],
  leads: [['deals', 'lead_id'], ['activities', 'lead_id']],
  deals: [['activities', 'deal_id']],
  activities: [],
};

for (const table of Object.keys(schemas)) {
  const label = labels[table];

  app.get(`/api/${table}/:id`, authenticate, route((req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(parseId(req));
    if (!row) return res.status(404).json({ error: `${label} not found. It may have been deleted.` });
    res.json(row);
  }));

  app.post(`/api/${table}`, authenticate, route((req, res) => {
    const values = schemas[table](body(req));
    if (table === 'activities') {
      values.user_id = req.user.id;
      if (!values.date_time) delete values.date_time; // use the database default (now)
    }
    const id = insertRecord(table, values);
    res.status(201).json({ id, message: `${label} created.` });
  }));

  app.put(`/api/${table}/:id`, authenticate, route((req, res) => {
    const id = parseId(req);
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!existing) return res.status(404).json({ error: `${label} not found. It may have been deleted.` });
    if (table === 'activities' && existing.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only edit activities you logged.' });
    }
    const values = schemas[table](body(req));
    if (table === 'activities' && !values.date_time) values.date_time = existing.date_time;
    updateRecord(table, id, values, { touch: table !== 'activities' });
    res.json({ id, message: `${label} updated.` });
  }));

  app.delete(`/api/${table}/:id`, authenticate, route((req, res) => {
    const id = parseId(req);
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!existing) return res.status(404).json({ error: `${label} not found. It may have already been deleted.` });
    const isOwnActivity = table === 'activities' && existing.user_id === req.user.id;
    if (req.user.role !== 'admin' && !isOwnActivity) {
      return res.status(403).json({ error: 'Only administrators can delete records.' });
    }
    transaction(() => {
      for (const [refTable, col] of unlinkOnDelete[table]) {
        db.prepare(`UPDATE ${refTable} SET ${col} = NULL WHERE ${col} = ?`).run(id);
      }
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    });
    res.json({ message: `${label} deleted.` });
  }));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'That action is not available.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That submission is too large.' });
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`CRM server running on http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other program or set PORT in .env.`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (err) => console.error('[error] Unhandled promise rejection:', err));

/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */
