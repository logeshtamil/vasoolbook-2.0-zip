'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const fields = {
  f_name: { value: 'B-1' },
  'qr-amount': { value: '1250' },
  'qr-remarks': { value: 'July collection' }
};
let sent = null;
const context = {
  $id: id => fields[id] || null,
  borrowers: [{ id: 'B-1', name: 'ANIL KUMAR', phone: '9876543210' }],
  upiIds: [{ id: 'UPI-1', vpa: 'moneylenders@upi' }],
  _qrSelUpiId: 'UPI-1',
  cfg: key => key === 'company' ? 'Money Lenders' : '',
  showToast: message => { throw new Error(message); },
  openWhatsAppMessage: (phone, message) => { sent = { phone, message }; }
};
vm.createContext(context);
vm.runInContext(extractFunction('qrSendUpiPaymentRequest'), context);
context.qrSendUpiPaymentRequest();

assert.equal(sent.phone, '9876543210');
assert.match(sent.message, /UPI Payment Request/);
assert.match(sent.message, /Name: ANIL KUMAR/);
assert.match(sent.message, /UPI ID: moneylenders@upi/);
assert.match(sent.message, /Amount: ₹1,250/);
assert.match(sent.message, /Remarks: July collection/);
assert.match(source, /qrSendUpiPaymentRequest\(\)/);
assert.match(source, /UPI Payment Request<\/button>/);

console.log(JSON.stringify({status: 'PASS', checks: ['qr-request-button', 'selected-borrower', 'upi-id', 'optional-amount-remarks']}, null, 2));
