'use strict';

(async () => {
  const user = await UI.initShell('/profile.html');
  const $ = UI.$;

  $('#p-email').textContent = user.email;
  $('#p-name').value = user.name;
  $('#p-member-since').textContent = new Date(user.createdAt).toLocaleDateString('en-MY', { year: 'numeric', month: 'long' });

  const musicEnabled = $('#payment-music-enabled');
  const musicUrl = $('#payment-music-url');
  const musicState = $('#payment-music-state');
  const musicError = $('#payment-music-error');

  function renderPaymentMusic(setting = {}) {
    musicEnabled.checked = setting.enabled === true;
    musicUrl.value = setting.youtubeUrl || '';
    musicState.textContent = musicEnabled.checked ? 'ON' : 'OFF';
  }

  musicEnabled.addEventListener('change', () => {
    musicState.textContent = musicEnabled.checked ? 'ON' : 'OFF';
  });

  try {
    const response = await Belanja.request('/profile/payment-music');
    renderPaymentMusic(response.setting);
  } catch (err) {
    musicError.textContent = Belanja.fieldError(err);
  }

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await Belanja.request('/auth/me', {
        method: 'PUT',
        body: Object.fromEntries(new FormData(e.target).entries()),
      });
      UI.toast('Name updated', 'success');
    } catch (err) {
      $('#p-error').textContent = Belanja.fieldError(err);
    } finally {
      btn.disabled = false;
    }
  });

  $('#payment-music-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    musicError.textContent = '';
    try {
      const response = await Belanja.request('/profile/payment-music', {
        method: 'PATCH',
        body: {
          enabled: musicEnabled.checked,
          youtubeUrl: musicUrl.value.trim(),
        },
      });
      renderPaymentMusic(response.setting);
      UI.toast('Payment checklist music updated', 'success');
    } catch (err) {
      musicError.textContent = Belanja.fieldError(err);
    } finally {
      btn.disabled = false;
    }
  });

  $('#p-logout').addEventListener('click', async () => {
    try { await Belanja.request('/auth/logout', { method: 'POST' }); } catch { /* offline */ }
    Belanja.clearAuthFlag();
    location.href = '/login.html';
  });
})();
