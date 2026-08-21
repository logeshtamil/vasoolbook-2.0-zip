'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('www/index.html', 'utf8');
const start = html.indexOf('var VBProcessing=(function(){');
const endMarker = 'window.VBProcessing=VBProcessing;';
const end = html.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'global processing controller exists');
const controllerSource = html.slice(start, end + endMarker.length);

const elements = Object.create(null);
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.style = {};
    this.attributes = Object.create(null);
    this.children = [];
    this.disabled = false;
    this.textContent = '';
    this._id = '';
    this._processingText = null;
    this._processingSpin = null;
  }
  set id(value) { this._id = value; if (value) elements[value] = this; }
  get id() { return this._id; }
  set innerHTML(value) {
    this._html = value;
    this._processingText = new FakeElement('span');
    this._processingText.textContent = 'Processing...';
    this._processingSpin = new FakeElement('span');
  }
  get innerHTML() { return this._html || ''; }
  appendChild(child) {
    this.children.push(child);
    if (child.id) elements[child.id] = child;
    return child;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(selector) {
    if (selector === '.vb-processing-text') return this._processingText;
    if (selector === '.vb-processing-spin') return this._processingSpin;
    return null;
  }
}

const document = {
  head: new FakeElement('head'),
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  createElement(tag) { return new FakeElement(tag); },
  getElementById(id) { return elements[id] || null; }
};
const toasts = [];
const context = {
  window: {}, document, Object, Array, String, Number, Math, Promise,
  setTimeout, clearTimeout,
  showToast(message, type) { toasts.push({ message, type }); }
};
context.window.window = context.window;
context.window.document = document;
vm.createContext(context);
vm.runInContext(controllerSource, context);

const processing = context.VBProcessing;
assert.ok(processing && typeof processing.run === 'function');
assert.match(controllerSource, /DEFAULT_DELAY=0/, 'processing popup appears immediately');
// Centered modal spinner (moved from a top-right corner badge): a translucent
// backdrop now blocks taps on everything behind it while visible, reinforcing
// the per-button disable/duplicate-action guard rather than relying on it alone.
assert.match(controllerSource, /#vb-processing-backdrop\{position:fixed;inset:0;/, 'a full-screen backdrop blocks taps while the centered spinner is up');
assert.match(controllerSource, /#vb-processing-indicator\{position:fixed;top:50%;left:50%;transform:translate\(-50%,-50%\)/, 'the spinner itself is centered, not a corner badge');
assert.match(controllerSource, /\.finally\(function\(\)\{/, 'async cleanup is guaranteed');
assert.match(controllerSource, /function complete\(token,status,message\)/, 'success and failure status lifecycle exists');
assert.match(controllerSource, /data-state="success"/, 'success state has a dedicated modern style');
assert.match(controllerSource, /data-state="error"/, 'error state has a dedicated modern style');
assert.match(html, /_installGlobalProcessingIndicators/, 'workflow wrappers are installed after app load');
[
  '_proceedSaveEntry','saveBorrower','saveDiscountClosure','confirmOTSNewLoan',
  '_exportDataAndroid','_importDataAndroid','backupToDrive','restoreFromDrive',
  '_gdRunRecoveryDiagnostics','generateAndShare','downloadDocTemplatePDF',
  'exportBorrowerStatsPDF','downloadCollectionPDF','shareOTSClosingImage'
].forEach(name => assert.match(html, new RegExp("\\['" + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'"), `${name} has standardized processing feedback`));
assert.match(html, /async function saveTopUp\(\)[\s\S]*?VBProcessing\.begin\('topup-save'/, 'Top-Up owns an explicit finally-safe processing guard');
assert.match(html, /wrapMethod\(window\.VBSQLServer,'run'/, 'SQL sync actions use the shared indicator');
assert.match(html, /wrapMethod\(window\.VBCloudStorage,'run'/, 'cloud adapter actions use the shared indicator');
assert.match(html, /finally\{[\s\S]*?VBProcessing\.complete\(processingToken/, 'web file import reports its outcome in finally');

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

(async function runBehaviorChecks() {
  const syncValue = processing.run('sync-fast', 'Saving...', () => 42, { delay: 20, timeout: 2000 });
  assert.equal(syncValue, 42, 'synchronous return values are preserved');
  assert.equal(document.getElementById('vb-processing-indicator').style.display, 'flex');
  assert.equal(document.getElementById('vb-processing-indicator').attributes['data-state'], 'success');
  await wait(950);
  assert.equal(document.getElementById('vb-processing-indicator').style.display, 'none');

  const button = new FakeElement('button');
  let release;
  const running = processing.run('save-one', 'Saving...', () => new Promise(resolve => { release = resolve; }), {
    delay: 0, timeout: 2000, trigger: button
  });
  await wait(10);
  const indicator = document.getElementById('vb-processing-indicator');
  assert.equal(indicator.style.display, 'flex', 'noticeable operation shows the indicator');
  assert.equal(button.disabled, true, 'initiating control is disabled while active');
  assert.equal(button.attributes['aria-busy'], 'true');
  assert.equal(processing.run('save-one', 'Saving...', () => true), false, 'duplicate action is rejected');
  release('saved');
  assert.equal(await running, 'saved');
  assert.equal(indicator.style.display, 'flex', 'success status remains briefly visible');
  assert.equal(indicator.attributes['data-state'], 'success');
  assert.equal(button.disabled, false, 'success restores the initiating control');
  assert.equal(button.attributes['aria-busy'], undefined);
  await wait(950);
  assert.equal(indicator.style.display, 'none', 'success status auto-closes');

  const failureButton = new FakeElement('button');
  await assert.rejects(
    processing.run('save-failure', 'Saving...', () => Promise.reject(new Error('expected failure')), {
      delay: 0, timeout: 2000, trigger: failureButton
    }),
    /expected failure/
  );
  assert.equal(indicator.style.display, 'flex', 'failure status remains briefly visible');
  assert.equal(indicator.attributes['data-state'], 'error');
  assert.equal(failureButton.disabled, false, 'failure restores the initiating control');
  await wait(950);
  assert.equal(indicator.style.display, 'none', 'failure status auto-closes');

  const timeoutButton = new FakeElement('button');
  const timedOut = processing.run('save-timeout', 'Saving...', () => new Promise(() => {}), {
    delay: 0, timeout: 1000, trigger: timeoutButton
  });
  await wait(1050);
  assert.equal(await timedOut, false, 'watchdog settles a stuck operation safely');
  assert.equal(indicator.style.display, 'flex', 'timeout status remains briefly visible');
  assert.equal(indicator.attributes['data-state'], 'error', 'timeout reports a failure state');
  assert.equal(timeoutButton.disabled, false, 'timeout restores the initiating control');
  assert.ok(toasts.some(item => /timed out/.test(item.message)), 'timeout is reported to the user');
  await wait(950);
  assert.equal(indicator.style.display, 'none', 'timeout status auto-closes');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'immediate-nonblocking-indicator','context-label','single-trigger-disable',
      'duplicate-action-guard','success-finally-cleanup','failure-finally-cleanup',
      'success-failure-status','status-auto-close','timeout-settlement','cloud-and-sync-wrappers','financial-workflow-coverage'
    ]
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
