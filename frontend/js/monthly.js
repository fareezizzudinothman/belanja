'use strict';

(async () => {
  await UI.initShell('/monthly.html');
  const $ = UI.$;
  const $$ = UI.$$;

  const params = new URLSearchParams(location.search);
  let serverNow = null;
  let year = parseInt(params.get('year'), 10) || null;
  let month = parseInt(params.get('month'), 10) || null;
  let data = null;
  let editingId = null;

  // Checklist modal state
  let checklistItems = [];
  let checklistReadOnly = false;
  let paymentMusicSetting = { enabled: false, youtubeId: null };
  let paymentMusicFrame = null;

  function pad(n) { return String(n).padStart(2, '0'); }

  function isOpen() {
    return !!(data.entry && data.entry.status === 'OPEN');
  }

  function subtitle() {
    switch (data.status) {
      case 'OPEN':
        return 'Expected recurring costs plus this month\u2019s actual expenses.';
      case 'CLOSED':
        return 'This month is closed and read-only. Historical values are preserved.';
      case 'FUTURE':
        return 'This is a future month. It cannot be opened yet.';
      case 'HISTORY':
        return 'Historical month outside the editable window. Read-only, cannot be reopened.';
      default: // NOT OPEN
        return 'This month is not open yet. Open it to start recording expenses.';
    }
  }

  function render() {
    setTitle();
    $('#month-sub').textContent = subtitle();

    const badge = $('#month-status');
    badge.textContent = data.status;
    badge.className = `badge ${data.status === 'CLOSED' ? 'closed' : data.status === 'OPEN' ? 'open' : 'idle'}`;

    const banner = $('#month-banner');
    banner.innerHTML = '';
    if (data.status === 'CLOSED') {
      banner.innerHTML = '<div class="banner closed">' +
        'This month is closed (read-only). Close protects the record: future changes to ' +
        'fixed expenses or installments will not change this month\'s snapshot.</div>';
    } else if (data.status === 'NOT OPEN') {
      banner.innerHTML = '<div class="banner">' +
        'This month is not open yet. Nothing is recorded until you open it.</div>';
    } else if (data.status === 'FUTURE') {
      banner.innerHTML = '<div class="banner idle">' +
        'Future month \u2014 it cannot be opened until the calendar reaches it.</div>';
    } else if (data.status === 'HISTORY') {
      banner.innerHTML = '<div class="banner idle">' +
        'This month is older than the editable window (current + previous 3 months). Read-only.</div>';
    }

    renderFixed();
    renderInst();
    renderVar();
    renderTotals();

    const openBtn = $('#open-month-btn');
    const closeBtn = $('#close-month-btn');
    const reopenBtn = $('#reopen-month-btn');
    const checklistBtn = $('#checklist-btn');
    openBtn.style.display = data.access.canOpen ? '' : 'none';
    closeBtn.style.display = data.access.canClose ? '' : 'none';
    reopenBtn.style.display = data.access.canReopen ? '' : 'none';
    checklistBtn.style.display = data.entry ? '' : 'none';
    openBtn.disabled = false;
    closeBtn.disabled = false;
    reopenBtn.disabled = false;
    checklistBtn.disabled = false;

    const addBtn = $('#add-var-btn');
    addBtn.style.display = isOpen() ? '' : 'none';
  }

  function setTitle() {
    const title = $('#month-title');
    title.textContent = UI.monthLabel(year, month);
    title.style.opacity = 1;
  }

  function syncVariableNav() {
    if (!year || !month) return;
    const href = `/variable-expenses.html?year=${year}&month=${month}`;
    document.querySelectorAll('a[data-nav="/variable-expenses.html"]').forEach((link) => {
      link.setAttribute('href', href);
    });
  }

  function renderFixed() {
    const wrap = $('#fixed-list');
    const items = data.fixedExpenses;
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No active fixed expenses for this month. <a href="/fixed-expenses.html">Add one&rarr;</a></div>';
      return;
    }
    wrap.innerHTML = items.map((f) => `
      <div class="total-line">
        <span>${UI.esc(f.name)} <span class="badge type">${UI.typeLabel(f.type)}</span></span>
        <strong>${UI.fmtMoney(f.amount)}</strong>
      </div>`).join('');
  }

  function renderInst() {
    const wrap = $('#inst-list');
    const items = data.installments;
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No active installments for this month. <a href="/installments.html">Add one&rarr;</a></div>';
      return;
    }
    wrap.innerHTML = items.map((i) => `
      <div class="total-line">
        <span>${UI.esc(i.loanName)} <span class="badge type">${UI.typeLabel(i.type)}</span></span>
        <strong>${UI.fmtMoney(i.monthlyInstallment)}</strong>
      </div>`).join('');
  }

  function renderVar() {
    const wrap = $('#var-list');
    const items = data.variableExpenses;
    const readOnly = data.status !== 'OPEN';
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No variable expenses recorded for this month yet.</div>';
      return;
    }
    wrap.innerHTML = items.map((v) => `
      <div class="total-line var-item">
        <span class="var-main">
          <span class="var-name">${UI.esc(v.name)}</span> <span class="badge type">${UI.typeLabel(v.type)}</span>
          <span class="var-meta muted small">${UI.esc(v.expenseDate)}${v.remarks ? ` &mdash; ${UI.esc(v.remarks)}` : ''}</span>
        </span>
        <span class="row-flex var-side">
          <strong>${UI.fmtMoney(v.amount)}</strong>
          <span class="actions var-actions">
            ${readOnly ? '' : `<button class="btn ghost small" data-edit="${v.id}" title="edit">&#9998;</button>
            <button class="btn ghost small" data-del="${v.id}" title="delete">&times;</button>`}
          </span>
        </span>
      </div>`).join('');

    wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openVarModal(b.dataset.edit)));
    wrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteVar(b.dataset.del)));
  }

  function renderTotals() {
    const t = data.totals;
    $('#sum-fixed').textContent = UI.fmtMoney(t.fixed);
    $('#sum-inst').textContent = UI.fmtMoney(t.installments);
    $('#sum-var').textContent = UI.fmtMoney(t.variable);
    $('#sum-total').textContent = UI.fmtMoney(t.total);
  }

  async function load() {
    data = await Belanja.request(`/monthly/${year}/${month}`);
    render();
  }

  // ---- Variable expense modal ----
  function fillTypeSelect() {
    const sel = $('#var-type');
    sel.innerHTML = UI.VARIABLE_TYPES.map((t) => `<option value="${t}">${UI.typeLabel(t)}</option>`).join('');
  }

  function openVarModal(id) {
    editingId = id;
    $('#var-error').textContent = '';
    const form = $('#var-form');
    form.reset();
    const title = $('#var-modal-title');
    if (id) {
      const v = data.variableExpenses.find((x) => x.id === id);
      if (!v) return;
      title.textContent = 'Edit Expense';
      form.elements.name.value = v.name;
      form.elements.type.value = v.type;
      form.elements.amount.value = v.amount;
      form.elements.expenseDate.value = v.expenseDate;
      form.elements.remarks.value = v.remarks || '';
    } else {
      title.textContent = 'Add Expense';
      form.elements.expenseDate.value = `${year}-${pad(month)}-01`;
    }
    UI.openModal('var-modal');
  }

  $('#add-var-btn').addEventListener('click', () => openVarModal(null));
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => {
    const modal = b.closest('dialog');
    if (modal) UI.closeModal(modal.id);
  }));

  $('#var-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    const dataObj = Object.fromEntries(new FormData(e.target).entries());
    btn.disabled = true;
    try {
      await Belanja.request(`/variable-expenses${editingId ? `/${editingId}` : ''}`, {
        method: editingId ? 'PUT' : 'POST',
        body: dataObj,
      });
      UI.closeModal('var-modal');
      UI.toast('Expense saved', 'success');
      await load();
    } catch (err) {
      $('#var-error').textContent = Belanja.fieldError(err);
    } finally {
      btn.disabled = false;
    }
  });

  async function deleteVar(id) {
    const v = data.variableExpenses.find((x) => x.id === id);
    if (!confirm(`Delete "${v ? v.name : 'this expense'}"? This cannot be undone.`)) return;
    try {
      await Belanja.request(`/variable-expenses/${id}`, { method: 'DELETE' });
      UI.toast('Expense deleted', 'success');
      await load();
    } catch (err) {
      UI.toast(Belanja.fieldError(err), 'error');
    }
  }

  // ---- Month navigation + lifecycle actions ----
  function goto(y, m) {
    year = y; month = m;
    history.replaceState(null, '', `/monthly.html?year=${y}&month=${m}`);
    syncVariableNav();
    $('#month-title').style.opacity = 0.4;
    load().catch((err) => UI.toast(err.message, 'error')).finally(() => { $('#month-title').style.opacity = 1; });
  }

  $('#prev-month').addEventListener('click', () => {
    const d = new Date(Date.UTC(year, month - 2, 1));
    goto(d.getUTCFullYear(), d.getUTCMonth() + 1);
  });
  $('#next-month').addEventListener('click', () => {
    const d = new Date(Date.UTC(year, month, 1));
    goto(d.getUTCFullYear(), d.getUTCMonth() + 1);
  });
  $('#today-btn').addEventListener('click', () => {
    if (serverNow) goto(serverNow.year, serverNow.month);
  });

  async function runAction(path, confirmMsg, doneMsg, doneType, btn) {
    if (!confirm(confirmMsg)) return;
    btn.disabled = true;
    btn.textContent = 'Please wait...';
    try {
      const res = await Belanja.request(`/monthly/${year}/${month}/${path}`, { method: 'POST' });
      data = res;
      render();
      UI.toast(doneMsg, doneType);
    } catch (err) {
      UI.toast(Belanja.fieldError(err), 'error');
      btn.disabled = false;
      btn.textContent = btn.dataset.label || '';
    }
  }

  function bindLifecycle(selector, action, label, buildConfirmMsg, doneMsg) {
    const btn = $(selector);
    btn.dataset.label = label;
    btn.addEventListener('click', (e) => runAction(action, buildConfirmMsg(), doneMsg, 'success', e.currentTarget));
  }

  bindLifecycle('#open-month-btn', 'open',
    'Open Month',
    () => `Open ${UI.monthLabel(year, month)}?\n\nOpening makes the month editable so you can record expenses.`,
    'Month opened.');

  bindLifecycle('#close-month-btn', 'close',
    'Close Month',
    () => `Close ${UI.monthLabel(year, month)}?\n\nOnce closed, this month becomes read-only and its fixed/installment values are frozen as a snapshot.`,
    'Month closed.');

  bindLifecycle('#reopen-month-btn', 'reopen',
    'Reopen Month',
    () => `Reopen ${UI.monthLabel(year, month)}?\n\nYou can correct data again. The historical snapshot is kept and rebuilt the next time you close the month.`,
    'Month reopened.');

  // ---- Payment Checklist Modal ----
  async function loadPaymentMusicSetting() {
    try {
      const response = await Belanja.request('/profile/payment-music');
      const setting = response.setting || {};
      paymentMusicSetting = {
        enabled: setting.enabled === true,
        youtubeId: setting.youtubeId || null,
      };
    } catch {
      // Music is optional; a settings request failure must not affect the checklist.
      paymentMusicSetting = { enabled: false, youtubeId: null };
    }
  }

  function stopPaymentMusic() {
    if (!paymentMusicFrame) return;
    paymentMusicFrame.remove();
    paymentMusicFrame = null;
  }

  function startPaymentMusic() {
    stopPaymentMusic();
    if (!paymentMusicSetting.enabled || !paymentMusicSetting.youtubeId) return;

    const frame = document.createElement('iframe');
    frame.id = 'payment-checklist-music-frame';
    frame.title = 'Payment checklist music';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.allow = 'autoplay; encrypted-media';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = `https://www.youtube.com/embed/${encodeURIComponent(paymentMusicSetting.youtubeId)}?autoplay=1&playsinline=1&rel=0`;
    frame.style.cssText = 'position:fixed;left:-1px;top:-1px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(frame);
    paymentMusicFrame = frame;
  }

  async function loadChecklist() {
    if (!data || !data.entry) return false;
    try {
      const res = await Belanja.request(`/checklist/${year}/${month}`);
      checklistItems = res.items || [];
      checklistReadOnly = data.status === 'CLOSED' || data.status === 'HISTORY' || data.status === 'FUTURE';
      renderChecklistModal();
      return true;
    } catch (err) {
      UI.toast(err.message, 'error');
      return false;
    }
  }

  function renderChecklistModal() {
    const container = $('#checklist-modal-container');
    const sub = $('#checklist-modal-sub');
    const saveBtn = $('#checklist-save-btn');
    const progressFill = $('.checklist-progress-fill');
    const progressText = $('.checklist-progress-text');

    sub.textContent = `${UI.monthLabel(year, month)}`;
    saveBtn.style.display = checklistReadOnly ? 'none' : '';

    // Group items by type
    const byType = { fixed: [], installment: [], variable: [] };
    checklistItems.forEach((it) => {
      if (byType[it.expense_type]) byType[it.expense_type].push(it);
    });

    const typeLabels = {
      fixed: 'FIXED EXPENSES',
      installment: 'INSTALLMENTS',
      variable: 'VARIABLE EXPENSES',
    };

    container.innerHTML = Object.entries(byType).map(([type, items]) => {
      if (items.length === 0) return '';
      return `
        <div class="checklist-section" style="margin-bottom: 16px;">
          <h4 style="margin: 0 0 8px; font-size: 13px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">${typeLabels[type]}</h4>
          ${items.map((it) => `
            <label class="checklist-item" style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--border); cursor: ${checklistReadOnly ? 'not-allowed' : 'pointer'};">
              <input type="checkbox" class="checklist-checkbox" data-id="${it.id}" ${it.paid ? 'checked' : ''} ${checklistReadOnly ? 'disabled' : ''} style="width: 22px; height: 22px; flex-shrink: 0;" />
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${UI.esc(it.name)}</div>
              </div>
              <div style="font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap;">${UI.fmtMoney(it.amount)}</div>
            </label>`).join('')}
        </div>`;
    }).join('');

    // Add checkbox handlers
    if (!checklistReadOnly) {
      container.querySelectorAll('.checklist-checkbox').forEach((cb) => {
        cb.addEventListener('change', () => {
          const itemId = cb.dataset.id;
          const item = checklistItems.find((x) => x.id === itemId);
          if (item) {
            item.paid = cb.checked;
            updateChecklistProgress();
          }
        });
      });
    }

    updateChecklistProgress();
  }

  function updateChecklistProgress() {
    const total = checklistItems.length;
    const paid = checklistItems.filter((it) => it.paid).length;
    const percent = total > 0 ? Math.round((paid / total) * 100) : 0;
    $('.checklist-progress-fill').style.width = `${percent}%`;
    $('.checklist-progress-text').textContent = `${paid} / ${total} Paid`;
  }

  async function saveChecklist() {
    const saveBtn = $('#checklist-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    $('#checklist-error').textContent = '';

    try {
      for (const item of checklistItems) {
        await Belanja.request(`/checklist/${item.id}`, {
          method: 'PATCH',
          body: { paid: item.paid },
        });
      }
      UI.toast('Payment checklist saved.', 'success');
      UI.closeModal('checklist-modal');
    } catch (err) {
      $('#checklist-error').textContent = Belanja.fieldError(err);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  $('#checklist-btn').addEventListener('click', async () => {
    // Insert the iframe before the existing checklist request so the click can
    // be used as the browser's autoplay gesture.
    startPaymentMusic();
    if (await loadChecklist()) {
      UI.openModal('checklist-modal');
    } else {
      stopPaymentMusic();
    }
  });

  $('#checklist-save-btn').addEventListener('click', saveChecklist);

  $('#checklist-modal').addEventListener('close', stopPaymentMusic);

  async function init() {
    try {
      syncVariableNav();
      const current = await Belanja.request('/monthly/current');
      serverNow = current;
      if (!year) year = current.year;
      if (!month) month = current.month;
      syncVariableNav();
      fillTypeSelect();
      await loadPaymentMusicSetting();
      await load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  init();
})();
