# Company knowledge (persistent memory)

- Internal system: FinDesk accounts-payable web app at http://localhost:4000 (sandbox, no real data).
- Login: username `admin`, password `admin123`. If the session expires, sign in again and redo the unsaved step.
- Source documents (invoices, emails) are in the files folder; use list_files to see them.
- In FinDesk, the amount to record for an invoice is "Total Amount Due" (including tax), not the subtotal.
- Verification claims use entity `invoice`, key `{ "vendor": "<vendor name>", "invoice_number": "<number>" }`,
  and fields among: amount, due_date (YYYY-MM-DD), po_number, status (pending|paid).
- Dates are stored in FinDesk as YYYY-MM-DD.
- In FinDesk invoice tables, only the ID in the first column is a link. To open an invoice, click that ID, or open http://localhost:4000/invoices/<ID> directly with browser_open. Invoice numbers (INV-...) are plain text and cannot be clicked.
