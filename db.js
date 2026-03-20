const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'ifcs'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'checker.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cage_name    TEXT NOT NULL,
    prod_number  TEXT,
    edb_type     TEXT,
    submitted_at TEXT DEFAULT (datetime('now')),
    ifc_data     TEXT,
    edb_data     TEXT,
    delta        TEXT,
    c01_ifc      INTEGER,
    pass_fail    TEXT
  );
`);

module.exports = { db, DATA_DIR };
