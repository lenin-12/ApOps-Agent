// The ONLY app-specific code in the agent: how the verifier reads FinDesk's database (read-only).
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.ERP_DB || path.join(__dirname, '..', '..', 'erp', 'findesk.db');

module.exports = {
  name: 'findesk',
  // Which printed labels mark each field in source documents (used for label-anchored validation).
  // Field types let the verifier detect conflicting values for the same label (e.g. original vs revised total).
  fieldTypes: { amount: 'number', due_date: 'date' },
  fieldLabels: {
    amount: ['Total Amount Due', 'Amount Due', 'Grand Total', 'Total Payable'],
    due_date: ['Due Date', 'Payment Due', 'Due On'],
    po_number: ['PO Reference', 'PO Number', 'Purchase Order'],
    invoice_number: ['Invoice No', 'Invoice Number', 'Invoice #'],
  },
  lookup(entity, key) {
    if (entity !== 'invoice') throw new Error(`Unknown entity "${entity}"`);
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const base = 'SELECT i.id, v.name AS vendor, i.invoice_number, i.amount, i.due_date, i.po_number, i.status FROM invoices i JOIN vendors v ON v.id = i.vendor_id';
      if (key.id) return db.prepare(base + ' WHERE i.id = ?').get(key.id);
      return db.prepare(base + ' WHERE lower(v.name) = lower(?) AND i.invoice_number = ?').get(key.vendor, key.invoice_number);
    } finally { db.close(); }
  },
};
