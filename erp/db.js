// FinDesk database layer (SQLite). The ERP is the "company system"; the agent never imports this file.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.ERP_DB || path.join(__dirname, 'findesk.db');

function open(opts) {
  return new Database(DB_PATH, opts);
}

function reset(db) {
  db.exec(`
    DROP TABLE IF EXISTS invoices;
    DROP TABLE IF EXISTS vendors;
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      invoice_number TEXT NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      po_number TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (vendor_id, invoice_number)
    );
  `);
  const addVendor = db.prepare('INSERT INTO vendors (name) VALUES (?)');
  ['Acme Corp', 'Globex Ltd', 'Initech'].forEach((n) => addVendor.run(n));
  const addInv = db.prepare(
    'INSERT INTO invoices (vendor_id, invoice_number, amount, due_date, po_number, status) VALUES (?,?,?,?,?,?)'
  );
  addInv.run(1, 'INV-1001', 18500.0, '2026-04-15', 'PO-7781', 'pending'); // Acme March, already entered
  addInv.run(3, 'INV-0055', 1150.0, '2026-10-01', 'PO-5501', 'pending'); // Initech, overdue
  addInv.run(2, 'INV-7731', 5200.0, '2026-09-30', 'PO-9001', 'pending'); // Globex, overdue
  addInv.run(2, 'INV-7700', 3100.0, '2026-08-20', 'PO-8900', 'paid'); // Globex, paid
}

function init(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vendors'").get();
  if (!has) reset(db);
}

module.exports = { open, reset, init, DB_PATH };
