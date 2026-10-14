const fs = require('fs');
const path = require('path');
const FILE = process.env.COMPANY_MEMORY || path.join(__dirname, 'company_memory.md');

const loadCompanyMemory = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '');
function appendCompanyRule(rule) {
  fs.appendFileSync(FILE, `\n- (learned) ${rule.trim()}`);
  return FILE;
}
module.exports = { loadCompanyMemory, appendCompanyRule };
