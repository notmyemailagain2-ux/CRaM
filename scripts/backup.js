/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */

'use strict';

// Creates a safe, consistent copy of the database in ./backups.
// Works while the server is running. Usage: npm run backup

const path = require('path');
const fs = require('fs');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // No .env file.
}

const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '..', process.env.DB_PATH || 'crm.db');
const backupDir = path.resolve(__dirname, '..', 'backups');

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const target = path.join(backupDir, `crm-${stamp}.db`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('VACUUM INTO ?').run(target);
db.close();

console.log(`Backup saved: ${target}`);

/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */
