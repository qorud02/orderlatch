'use strict';

(function () {
  var state = null;
  var health = null;
  var busy = false;
  var dirty = false;
  var noticeTimer = null;
  var lastAnalysisHash = null;
  var $ = function (id) { return document.getElementById(id); };
  var moneyCurrencies = ['USD', 'EUR', 'GBP', 'KRW'];

  function text(element, value) {
    element.textContent = value === null || value === undefined ? '' : String(value);
  }

  function make(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) text(element, value);
    return element;
  }

  function shortHash(hash) {
    return typeof hash === 'string' && hash.length ? hash.slice(0, 12) + '…' + hash.slice(-6) : 'Awaiting comparison';
  }

  function formatAmount(minor, currency) {
    if (!Number.isFinite(minor) || !moneyCurrencies.includes(currency)) return null;
    var places = currency === 'KRW' ? 0 : 2;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency, minimumFractionDigits: places, maximumFractionDigits: places }).format(minor / (places ? 100 : 1));
    } catch (_) { return null; }
  }

  function blockerCount() {
    if (!state || !state.analysis) return null;
    var blockers = state.analysis.blockers;
    if (Array.isArray(blockers)) return blockers.length;
    if (Number.isFinite(blockers)) return blockers;
    return (state.analysis.fields || []).filter(function (field) { return field.status !== 'match'; }).length;
  }

  function hasClearAnalysis() {
    return Boolean(state && state.analysis && Array.isArray(state.analysis.fields) && state.analysis.fields.length && blockerCount() === 0 && !dirty);
  }

  function acknowledged(role) {
    return Boolean(state && state.snapshotHash && state.approvals && state.approvals[role] && state.approvals[role].hash === state.snapshotHash);
  }

  function bothAcknowledged() {
    return hasClearAnalysis() && acknowledged('buyer') && acknowledged('supplier');
  }

  function paymentState() {
    return state && state.payment && state.payment.status || 'none';
  }

  function sourcesChanged() {
    if (!state) return false;
    return $('buyer-text').value !== (state.buyerText || '') || $('supplier-text').value !== (state.supplierText || '');
  }

  function showMessage(message, kind, persistent) {
    clearTimeout(noticeTimer);
    var box = $('feedback');
    box.className = 'notice notice-' + (kind || 'info');
    text(box, message);
    box.hidden = false;
    if (!persistent && kind === 'success') noticeTimer = setTimeout(function () { box.hidden = true; }, 6500);
  }

  function hideMessage() {
    clearTimeout(noticeTimer);
    $('feedback').hidden = true;
  }

  async function api(path, method, body) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 100000);
    var response;
    try {
      response = await fetch(path, {
        method: method || 'GET',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-OrderLatch-Client': 'web' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store'
      });
      var data;
      try { data = await response.json(); } catch (_) { data = {}; }
      if (!response.ok) {
        var error = new Error(data.error && data.error.message || 'The request could not be completed. Please try again.');
        error.code = data.error && data.error.code || 'REQUEST_FAILED';
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        var timed = new Error('The request took too long. Your last confirmed revision is preserved. Try again.');
        timed.code = 'CLIENT_TIMEOUT';
        throw timed;
      }
      if (error instanceof TypeError) throw new Error('Connection interrupted. Check that OrderLatch is running, then try again.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function setBusy(value, label) {
    busy = value;
    $('busy-overlay').hidden = !value;
    text($('busy-label'), label || 'Working…');
    $('main').setAttribute('aria-busy', value ? 'true' : 'false');
    renderControls();
  }

  async function act(label, callback, success) {
    if (busy) return;
    hideMessage();
    setBusy(true, label);
    try {
      var next = await callback();
      if (next && next.id) {
        state = next;
        dirty = false;
        render(true);
      }
      if (success) showMessage(success, 'success');
    } catch (error) {
      showMessage(error.message, 'error', true);
      if (error.status === 409 || error.code === 'STALE_REVISION' || error.code === 'STALE_SNAPSHOT') {
        try { state = await api('/api/state'); dirty = false; render(true); } catch (_) { /* Preserve the last observed state. */ }
      }
    } finally { setBusy(false); }
  }

  function renderHealth() {
    var badge = $('ai-connection');
    badge.replaceChildren(make('i'));
    badge.appendChild(document.createTextNode(health && health.aiConfigured ? 'AI connected' : 'AI not configured'));
    badge.className = 'connection ' + (health && health.aiConfigured ? 'ready' : 'unavailable');
    var notices = [];
    if (!health || !health.aiConfigured) notices.push('Connect the workspace AI service to compare new documents.');
    if (health && !health.paypalConfigured) notices.push('PayPal Sandbox is not configured; you can review and acknowledge an order before connecting checkout.');
    text($('connection-notice'), notices.join(' '));
    $('connection-notice').hidden = notices.length === 0;
  }

  function renderSourceDocuments(force) {
    if (!state) return;
    if (force || !dirty) {
      $('buyer-text').value = state.buyerText || '';
      $('supplier-text').value = state.supplierText || '';
    }
    text($('revision-pill'), 'Revision ' + state.revision);
    text($('case-tag'), state.title || 'SAMPLE ORDER');
    text($('proof-label'), state.proof && state.proof.label || '—');
    text($('proof-fingerprint'), state.proof && state.proof.sha256 ? 'SHA-256 ' + shortHash(state.proof.sha256) : 'No proof loaded');
  }

  function sideCell(side, fieldStatus) {
    var td = make('td');
    var value = side && side.value;
    var shownValue = value === '' || value === null || value === undefined ? 'Not found' : typeof value === 'object' ? JSON.stringify(value) : value;
    td.appendChild(make('span', 'field-value' + (side && side.verified === false ? ' unverified' : ''), shownValue));
    if (side && side.evidence) {
      var details = make('details', 'evidence-details');
      var summary = make('summary', '', 'Source evidence');
      details.appendChild(summary);
      details.appendChild(make('blockquote', '', side.evidence));
      if (side.verified === true) details.appendChild(make('span', 'evidence-verified', '✓ Exact excerpt verified'));
      else if (side.verified === false) details.appendChild(make('span', 'evidence-verified unverified', 'Excerpt needs review'));
      if (fieldStatus !== 'match') details.open = true;
      td.appendChild(details);
    } else td.appendChild(make('span', 'evidence-verified unverified', 'No supporting excerpt'));
    return td;
  }

  function renderComparison() {
    var analysis = state && state.analysis;
    var fields = analysis && Array.isArray(analysis.fields) ? analysis.fields : [];
    var hasAnalysis = Boolean(analysis && fields.length);
    var count = blockerCount();
    $('comparison-empty').hidden = hasAnalysis;
    $('comparison-table-wrap').hidden = !hasAnalysis;
    $('comparison-overview').hidden = !hasAnalysis;
    $('comparison-count').hidden = !hasAnalysis;
    $('comparison-rows').replaceChildren();
    if (!hasAnalysis) { lastAnalysisHash = null; return; }
    var isClear = count === 0;
    text($('comparison-count'), isClear ? 'All clear' : count + (count === 1 ? ' blocker' : ' blockers'));
    $('comparison-count').className = 'count-badge' + (isClear ? ' clear' : '');
    $('comparison-overview').className = 'comparison-overview' + (isClear ? ' clear' : '');
    text($('overview-icon'), isClear ? '✓' : '!');
    text($('overview-title'), isClear ? 'Both documents describe the same order.' : count + (count === 1 ? ' term needs' : ' terms need') + ' your attention.');
    var summary = typeof analysis.summary === 'string' ? analysis.summary : '';
    text($('overview-description'), summary || (isClear ? 'Review the evidence, then acknowledge this revision as each demo persona.' : 'Edit the source terms and compare again. Checkout stays paused until every critical term is supported and aligned.'));
    text($('model-label'), analysis.provider ? analysis.provider + ' · ' + (analysis.model || 'AI extraction') : 'AI extraction');
    fields.forEach(function (field) {
      var status = ['match', 'mismatch', 'missing', 'uncertain'].includes(field.status) ? field.status : 'uncertain';
      var tr = make('tr', status === 'match' ? '' : 'issue-row');
      var termCell = make('td', '', field.label || field.key || 'Order term');
      tr.appendChild(termCell);
      tr.appendChild(sideCell(field.buyer, status));
      tr.appendChild(sideCell(field.supplier, status));
      var statusCell = make('td');
      var labels = { match: 'Matched', mismatch: 'Mismatch', missing: 'Missing', uncertain: 'Review needed' };
      statusCell.appendChild(make('span', 'result-tag ' + status, labels[status]));
      tr.appendChild(statusCell);
      $('comparison-rows').appendChild(tr);
    });
    lastAnalysisHash = state.snapshotHash;
  }

  function renderGate() {
    var analysis = state && state.analysis;
    var clear = hasClearAnalysis();
    var ack = bothAcknowledged();
    var payment = paymentState();
    var completed = payment === 'completed';
    var gate = document.querySelector('.decision-card');
    gate.className = 'decision-card' + (completed ? ' completed' : ack ? ' ready' : '');
    var title = 'Checkout paused';
    var reason = 'Run the comparison to review the order terms.';
    if (dirty) reason = 'Save and compare the edited documents before continuing.';
    else if (completed) { title = 'Payment verified'; reason = 'PayPal confirmed a completed capture for this acknowledged revision.'; }
    else if (payment === 'stale') {
      if (ack) { title = 'Ready for new checkout'; reason = 'Both demo personas acknowledged this revision. The previous checkout is stale; create a new Sandbox order.'; }
      else reason = clear ? 'The previous checkout is stale. Record both demo acknowledgements for this revision before creating a new Sandbox order.' : 'This order changed. The previous checkout is stale; compare and acknowledge the new revision.';
    }
    else if (payment === 'pending') { title = 'Payment pending'; reason = 'PayPal has not confirmed a completed capture. No completed payment is recorded.'; }
    else if (ack) { title = payment === 'created' ? 'Approval requested' : 'Ready for checkout'; reason = payment === 'created' ? 'Complete the Sandbox approval, then verify the payment for this revision.' : 'Both demo personas acknowledged the same revision. The server can create the test order.'; }
    else if (clear) { title = 'Terms aligned'; reason = 'Review the evidence and record both demo acknowledgements to unlock checkout.'; }
    else if (analysis) {
      var count = blockerCount();
      reason = count + (count === 1 ? ' blocking term needs' : ' blocking terms need') + ' review before this order can proceed.';
    }
    text($('gate-title'), title);
    text($('gate-reason'), reason);
    var total = state && formatAmount(state.totalMinor, state.currency);
    $('order-total').replaceChildren(document.createTextNode(total || '—'));
    $('order-total').appendChild(make('small', '', total ? (state.currency + ' · server-calculated') : 'Compare to calculate'));
    text($('revision-seal'), state && state.snapshotHash ? shortHash(state.snapshotHash) : 'Awaiting comparison');
    text($('revision-seal-note'), dirty ? 'Unsaved changes are not part of this seal.' : 'A source or proof change creates a new seal.');
    setGateCheck('check-evidence', clear, '1');
    setGateCheck('check-acknowledgements', ack, '2');
    setGateCheck('check-payment', completed, '3');
    setProgress('step-compare', Boolean(analysis && !dirty), !analysis || !clear || dirty);
    setProgress('step-approve', ack, clear && !ack);
    setProgress('step-pay', completed, ack && !completed);
  }

  function setGateCheck(id, done, number) {
    $(id).className = done ? 'checked' : '';
    text($(id).querySelector('.check-indicator'), done ? '✓' : number);
  }

  function setProgress(id, done, current) {
    $(id).className = 'progress-step' + (done ? ' done' : current ? ' current' : '');
  }

  function renderAcknowledgements() {
    ['buyer', 'supplier'].forEach(function (role) {
      var done = acknowledged(role);
      text($(role + '-ack-status'), done ? 'Acknowledged · revision ' + state.revision : hasClearAnalysis() ? 'Ready to acknowledge' : 'Review pending');
      text($(role + '-ack-icon'), done ? '✓' : '○');
      $(role + '-ack-icon').className = 'ack-state' + (done ? ' done' : '');
      text($('approve-' + role), done ? 'Acknowledged this revision' : 'Acknowledge as ' + role);
    });
  }

  function sandboxApprovalUrl(raw) {
    if (typeof raw !== 'string') return null;
    try {
      var url = new URL(raw);
      if (url.protocol === 'https:' && ['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname) && !url.username && !url.password) return url.href;
    } catch (_) { /* Invalid URLs never become clickable. */ }
    return null;
  }

  function appendReceiptTerm(label, value) {
    $('payment-receipt').appendChild(make('dt', '', label));
    $('payment-receipt').appendChild(make('dd', '', value));
  }

  function renderPayment() {
    var payment = state && state.payment || {};
    var status = paymentState();
    var labels = { none: bothAcknowledged() ? 'Ready to create test order' : 'Waiting for review', created: 'Awaiting Sandbox approval', completed: 'Capture completed · verified', stale: 'Previous checkout is stale', pending: 'Awaiting completed capture', failed: 'Payment needs attention' };
    text($('payment-status-label'), labels[status] || 'Payment needs review');
    $('payment-state').className = 'payment-state ' + status;
    var approvalUrl = sandboxApprovalUrl(payment.approvalUrl);
    var canOpen = status === 'created' && approvalUrl && !dirty && payment.boundHash === state.snapshotHash;
    $('open-paypal').hidden = !canOpen;
    if (canOpen) $('open-paypal').href = approvalUrl;
    else $('open-paypal').removeAttribute('href');
    $('payment-instruction').hidden = !canOpen;
    $('capture-order').hidden = !['created', 'pending', 'failed'].includes(status) || !payment.orderId;
    $('create-order').hidden = status === 'completed' || status === 'created' || status === 'pending';
    $('payment-receipt').replaceChildren();
    var hasReceipt = Boolean(payment.orderId || payment.captureId);
    $('payment-receipt').hidden = !hasReceipt;
    if (payment.orderId) appendReceiptTerm('PayPal order', payment.orderId);
    if (payment.captureId) appendReceiptTerm('Capture', payment.captureId);
    if (payment.amount) appendReceiptTerm('Amount', payment.currency ? payment.currency + ' ' + payment.amount : payment.amount);
    if (payment.boundHash) appendReceiptTerm('Bound revision', shortHash(payment.boundHash));
    $('download-receipt').hidden = status !== 'completed';
  }

  function renderHistory() {
    var list = $('history-list');
    list.replaceChildren();
    var events = state && Array.isArray(state.events) ? state.events : [];
    if (!events.length) { list.appendChild(make('li', 'history-placeholder', 'The order history will appear here.')); return; }
    events.slice().reverse().slice(0, 12).forEach(function (event) {
      var li = make('li');
      li.appendChild(make('span', 'history-node'));
      var content = make('div', 'history-content');
      content.appendChild(make('strong', '', event.message || event.type || 'Order updated'));
      if (event.type) content.appendChild(make('small', '', String(event.type).replace(/[_-]/g, ' ')));
      li.appendChild(content);
      var date = new Date(event.at);
      if (!Number.isNaN(date.getTime())) {
        var time = make('time', 'history-time', new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date));
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString();
        li.appendChild(time);
      }
      list.appendChild(li);
    });
  }

  function renderControls() {
    var complete = paymentState() === 'completed';
    var clear = hasClearAnalysis();
    $('load-sample').disabled = busy;
    $('scenario').disabled = busy;
    $('buyer-text').readOnly = busy || complete;
    $('supplier-text').readOnly = busy || complete;
    $('save-sources').disabled = busy || !dirty || complete;
    $('undo-edits').hidden = !dirty;
    $('undo-edits').disabled = busy;
    $('unsaved-tag').hidden = !dirty;
    $('new-sample-proof').disabled = busy || complete || !state;
    $('proof-file').disabled = busy || complete || !state;
    document.querySelector('.upload-label').classList.toggle('disabled', busy || complete || !state);
    $('analyze').disabled = busy || !state || complete || !(health && health.aiConfigured);
    text($('analyze-label'), busy ? 'Working…' : dirty ? 'Save & compare with AI' : state && state.analysis ? 'Compare again' : 'Run AI comparison');
    ['buyer', 'supplier'].forEach(function (role) {
      $('approve-' + role).disabled = busy || !clear || acknowledged(role) || complete;
    });
    $('create-order').disabled = busy || !bothAcknowledged() || !(health && health.paypalConfigured) || complete;
    $('capture-order').disabled = busy || !bothAcknowledged() || !(health && health.paypalConfigured) || !state || !state.payment || state.payment.boundHash !== state.snapshotHash;
    $('open-paypal').setAttribute('aria-disabled', busy ? 'true' : 'false');
    $('download-receipt').disabled = busy;
  }

  function render(forceSources) {
    renderHealth();
    renderSourceDocuments(forceSources);
    renderComparison();
    renderGate();
    renderAcknowledgements();
    renderPayment();
    renderHistory();
    renderControls();
  }

  function onEdit() {
    dirty = sourcesChanged();
    renderGate();
    renderAcknowledgements();
    renderPayment();
    renderControls();
  }

  async function saveSourceChanges() {
    return api('/api/sources', 'PUT', { buyerText: $('buyer-text').value, supplierText: $('supplier-text').value, expectedRevision: state.revision });
  }

  function encodeText(value) {
    var bytes = new TextEncoder().encode(value);
    var binary = '';
    bytes.forEach(function (byte) { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function wireEvents() {
    $('buyer-text').addEventListener('input', onEdit);
    $('supplier-text').addEventListener('input', onEdit);
    $('undo-edits').addEventListener('click', function () { dirty = false; render(true); hideMessage(); });
    $('load-sample').addEventListener('click', function () {
      act('Loading sample order…', function () { return api('/api/reset', 'POST', { scenario: $('scenario').value }); }, 'Fictional sample loaded. Run AI comparison to review its terms.');
    });
    $('save-sources').addEventListener('click', function () { act('Saving a new revision…', saveSourceChanges, 'Sources saved. Previous acknowledgements and checkout no longer apply.'); });
    $('analyze').addEventListener('click', function () {
      act('Comparing source evidence…', async function () {
        if (dirty) { state = await saveSourceChanges(); dirty = false; render(true); }
        return api('/api/analyze', 'POST', {});
      }, 'AI comparison finished. Review the values and their exact source excerpts.');
    });
    ['buyer', 'supplier'].forEach(function (role) {
      $('approve-' + role).addEventListener('click', function () {
        act('Recording demo ' + role + ' acknowledgement…', function () { return api('/api/approve', 'POST', { role: role, expectedHash: state.snapshotHash }); });
      });
    });
    $('new-sample-proof').addEventListener('click', function () {
      act('Creating a new proof revision…', function () {
        var label = 'OL-v' + (Number(state.revision) + 3);
        return api('/api/proof', 'POST', { label: label, fileName: label + '-sample.txt', contentBase64: encodeText('OrderLatch fictional production proof\nVersion: ' + label + '\nChanged sample proof created at ' + new Date().toISOString()) });
      }, 'The proof changed. Review and acknowledge the new revision before creating another checkout.');
    });
    $('proof-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { showMessage('Choose a proof file no larger than 2 MB.', 'error', true); this.value = ''; return; }
      if (!/\.(txt|png|jpg|jpeg|pdf)$/i.test(file.name)) { showMessage('Use a TXT, PNG, JPEG or PDF proof file.', 'error', true); this.value = ''; return; }
      act('Attaching the new proof…', async function () {
        var encoded = await new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
          reader.onerror = function () { reject(new Error('The selected proof could not be read. Choose the file again.')); };
          reader.readAsDataURL(file);
        });
        var result = await api('/api/proof', 'POST', { label: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, contentBase64: encoded });
        $('proof-file').value = '';
        return result;
      }, 'New proof attached. Prior acknowledgements and checkout are stale.');
    });
    $('create-order').addEventListener('click', function () {
      act('Creating the bound PayPal Sandbox order…', function () { return api('/api/paypal/order', 'POST', { expectedHash: state.snapshotHash }); }, 'Sandbox order created. Open the PayPal approval, then return here to verify it.');
    });
    $('open-paypal').addEventListener('click', function (event) { if (busy || this.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
    $('capture-order').addEventListener('click', function () {
      act('Verifying the bound order with PayPal…', function () { return api('/api/paypal/capture', 'POST', { expectedHash: state.snapshotHash, orderId: state.payment.orderId }); });
    });
    $('download-receipt').addEventListener('click', function () {
      if (!state || paymentState() !== 'completed') return;
      var receipt = { product: 'OrderLatch', sampleData: true, caseId: state.id, revision: state.revision, snapshotHash: state.snapshotHash, acknowledgements: state.approvals, payment: state.payment, exportedAt: new Date().toISOString() };
      var url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
      var anchor = make('a');
      anchor.href = url;
      anchor.download = 'orderlatch-sample-review-receipt.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    });
    window.addEventListener('beforeunload', function (event) { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  }

  async function initialize() {
    wireEvents();
    setBusy(true, 'Opening the review desk…');
    try {
      var results = await Promise.all([api('/api/health'), api('/api/state')]);
      health = results[0];
      state = results[1];
      render(true);
    } catch (error) {
      health = { aiConfigured: false, paypalConfigured: false };
      renderHealth();
      showMessage(error.message + ' Reload the page to reconnect.', 'error', true);
    } finally { setBusy(false); }
  }

  initialize();
}());
