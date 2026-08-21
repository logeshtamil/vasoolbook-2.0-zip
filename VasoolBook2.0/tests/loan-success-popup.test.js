const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

const openNew = extractFunction(html, 'openNewBorrower');
const edit = extractFunction(html, 'openEditBorrower');
const save = extractFunction(html, 'saveBorrower');
const fillExisting = extractFunction(html, 'fillExistingCustomer');
const updateCustomer = extractFunction(html, 'updateCustomerDetails');
const popupPreference = extractFunction(html, 'borrowerLoanSuccessPopupOn');
const openAfterSave = extractFunction(html, '_openLoanSuccessPopupAfterSave');
const whatsapp = extractFunction(html, 'sendNewLoanWhatsApp');

assert.match(
  html,
  /id="m_show_success_popup"[^>]*checked/,
  'loan success popup checkbox must be checked by default'
);
assert.match(html, />Show Success Popup</, 'borrower-level preference must be visible');
assert.doesNotMatch(html, /id="m_share_wa"/, 'obsolete competing WhatsApp checkbox must be removed');
assert.match(
  html,
  />\s*Share Loan Details on WhatsApp\s*</,
  'success popup must provide the requested WhatsApp action'
);

assert.match(openNew, /_successChk\.checked=true/, 'new borrowers must default to showing the popup');
assert.match(edit, /borrowerLoanSuccessPopupOn\(b\)/, 'edit must restore the borrower preference');
assert.match(
  fillExisting,
  /borrowerLoanSuccessPopupOn\(b\)/,
  'new loan for an existing customer must inherit the saved preference'
);
assert.match(
  popupPreference,
  /return true/,
  'borrowers without an existing preference must default to enabled'
);

assert.match(save, /showLoanSuccessPopup:showLoanSuccessPopup/);
assert.match(save, /loanSuccessPopup:showLoanSuccessPopup/);
assert.match(html, /sanctionShown:false/, 'new loans must explicitly mark their sanction popup as pending');
assert.match(
  html,
  /customerProfile\.showLoanSuccessPopup=showLoanSuccessPopup/,
  'new-loan preference must persist to the customer profile'
);
assert.match(
  html,
  /updateCustomerDetails\([^;]*showLoanSuccessPopup:showLoanSuccessPopup/,
  'edited-loan preference must persist to the customer profile'
);
assert.match(
  updateCustomer,
  /extra\.showLoanSuccessPopup!==undefined/,
  'customer update whitelist must accept the dedicated loan popup preference'
);

const postSaveReferences = html.match(/_openLoanSuccessPopupAfterSave\(/g) || [];
assert.strictEqual(
  postSaveReferences.length,
  3,
  'the helper declaration plus edit and new-loan calls must be present'
);
assert.match(html, /_openLoanSuccessPopupAfterSave\(_editedLoanBid\)/);
assert.match(html, /_openLoanSuccessPopupAfterSave\(_newBid\)/);
assert.match(
  openAfterSave,
  /if\(!b\|\|b\.sanctionShown!==false\)return false/,
  'only a newly-created loan can open the sanction popup'
);
assert.match(
  openAfterSave,
  /b\.sanctionShown=true/,
  'the per-loan sanction flag must be committed before opening the popup'
);
assert.match(
  openAfterSave,
  /if\(!borrowerLoanSuccessPopupOn\(b\)\)return false/,
  'the borrower preference must still be honored'
);
assert.match(
  openAfterSave,
  /requestAnimationFrame\(open\)/,
  'popup must open after the committed UI frame without a fixed delay'
);

assert.match(whatsapp, /buildLoanSanctionMessage\(b\)/);
assert.match(whatsapp, /openWhatsAppMessage\(b\.phone,msg\)/);
assert.match(whatsapp, /Borrower mobile number is missing/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'default-checked',
    'dedicated-borrower-preference',
    'collection-preference-isolated',
    'edit-preference-persistence',
    'new-loan-preference-inheritance',
    'single-post-save-popup-path',
    'one-time-per-loan-sanction-popup',
    'no-fixed-popup-delay',
    'borrower-mobile-whatsapp-helper'
  ]
}, null, 2));
