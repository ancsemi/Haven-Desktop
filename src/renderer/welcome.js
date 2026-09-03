// ═══════════════════════════════════════════════════════════
// Haven Desktop — Welcome Screen Logic
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const pages = document.querySelectorAll('.page');
  const i18n = window.haven.i18n;

  function t(key, values) {
    return i18n.t(key, values);
  }

  function setTranslatedText(element, key, values) {
    if (!element) return;
    element.dataset.i18n = key;
    element.dataset.i18nValues = JSON.stringify(values || {});
    element.textContent = t(key, values);
  }

  function setErrorText(element, message, fallbackKey) {
    if (message) {
      delete element.dataset.i18n;
      delete element.dataset.i18nValues;
      element.textContent = message;
      return;
    }
    setTranslatedText(element, fallbackKey);
  }

  function applyTranslations(state = i18n.getState()) {
    document.documentElement.lang = state.locale;
    document.documentElement.dir = state.direction;

    document.querySelectorAll('[data-i18n]').forEach(element => {
      let values = {};
      try { values = JSON.parse(element.dataset.i18nValues || '{}'); } catch {}
      element.textContent = t(element.dataset.i18n, values);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
      element.title = t(element.dataset.i18nTitle);
    });

    const languageSelect = $('#language-select');
    languageSelect.replaceChildren();
    const systemOption = document.createElement('option');
    systemOption.value = 'auto';
    systemOption.textContent = t('language.automatic');
    languageSelect.appendChild(systemOption);
    for (const locale of state.supportedLocales) {
      const option = document.createElement('option');
      option.value = locale.code;
      option.textContent = locale.name;
      languageSelect.appendChild(option);
    }
    languageSelect.value = state.preference;
  }

  applyTranslations();
  i18n.onChanged(applyTranslations);

  $('#language-select').addEventListener('change', async (event) => {
    const state = await i18n.setLanguage(event.target.value);
    applyTranslations(state);
  });

  function showPage(id) {
    pages.forEach(p => p.classList.remove('active'));
    $(id).classList.add('active');
  }

  // ── Title-bar buttons ───────────────────────────────────
  $('#btn-min').onclick   = () => window.haven.window.minimize();
  $('#btn-close').onclick = () => window.haven.window.close();

  // ═══════ Page 1 — Choose Mode ═══════════════════════════

  $('#card-host').onclick = () => { showPage('#page-host'); detectServer(); };
  $('#card-join').onclick = () => { showPage('#page-join'); $('#server-url').focus(); };

  // ═══════ Page 2a — Host Flow ════════════════════════════

  $('#host-back').onclick = () => showPage('#page-choose');
  $('#btn-retry').onclick = () => detectServer();

  async function detectServer() {
    // Reset UI
    $('#host-detect').style.display    = 'flex';
    $('#host-found').style.display     = 'none';
    $('#host-missing').style.display   = 'none';
    $('#host-starting').style.display  = 'none';
    $('#host-error').style.display     = 'none';

    try {
      const result = await window.haven.server.detect();

      $('#host-detect').style.display = 'none';

      if (result.found) {
        $('#host-path').textContent    = result.path;
        $('#host-version').textContent = result.version ? `v${result.version}` : '';
        $('#host-found').style.display = 'block';
      } else {
        $('#host-missing').style.display = 'block';
      }
    } catch (err) {
      $('#host-detect').style.display  = 'none';
      setErrorText($('#host-error-msg'), err.message, 'welcome.error.detectionFailed');
      $('#host-error').style.display   = 'block';
    }
  }

  // Start server
  $('#btn-start-server').onclick = async () => {
    const serverPath = $('#host-path').textContent;
    await startServer(serverPath);
  };

  // Browse for server directory
  $('#btn-browse-server').onclick = async () => {
    const dir = await window.haven.server.browse();
    if (!dir) return;
    // Check if server.js exists there
    await startServer(dir);
  };

  // Fresh server setup — link to Haven repo / instructions
  $('#btn-setup-new').onclick = () => {
    window.haven.openExternal('https://github.com/ancsemi/Haven#one-click-setup');
  };

  async function startServer(serverPath) {
    $('#host-found').style.display    = 'none';
    $('#host-missing').style.display  = 'none';
    $('#host-error').style.display    = 'none';
    $('#host-starting').style.display = 'block';

    const logBox = $('#host-log');
    logBox.textContent = '';

    // Subscribe to server log
    window.haven.server.onLog((msg) => {
      logBox.textContent += msg;
      logBox.scrollTop = logBox.scrollHeight;
    });

    try {
      const res = await window.haven.server.start(serverPath);

      if (res.success) {
        const remember = $('#chk-remember').checked;
        const serverUrl = res.url || `http://localhost:${res.port}`;

        // Persist preferences (merge with existing to preserve audioInput etc.)
        const existing = await window.haven.settings.get('userPrefs') || {};
        await window.haven.settings.set('userPrefs', {
          ...existing,
          mode: 'host',
          serverUrl: serverUrl,
          serverPath: serverPath,
          skipWelcome: remember,
        });

        // Navigate to app
        window.haven.nav.openApp(serverUrl);
      } else {
        $('#host-starting').style.display = 'none';
        if (res.errorKey) setTranslatedText($('#host-error-msg'), res.errorKey);
        else setErrorText($('#host-error-msg'), res.error, 'welcome.error.startFailed');
        $('#host-error').style.display    = 'block';
      }
    } catch (err) {
      $('#host-starting').style.display = 'none';
      setErrorText($('#host-error-msg'), err.message, 'welcome.error.unexpected');
      $('#host-error').style.display    = 'block';
    }
  }

  // ═══════ Page 2b — Join Flow ════════════════════════════

  const urlInput   = $('#server-url');
  const connectBtn = $('#btn-connect');
  const joinError  = $('#join-error');

  $('#join-back').onclick = () => showPage('#page-choose');

  urlInput.addEventListener('input', () => {
    connectBtn.disabled = !urlInput.value.trim();
    joinError.style.display = 'none';
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !connectBtn.disabled) connectBtn.click();
  });

  connectBtn.onclick = async () => {
    let url = urlInput.value.trim();
    joinError.style.display = 'none';

    // Auto-prefix https if missing
    if (url && !url.match(/^https?:\/\//i)) {
      url = 'https://' + url;
      urlInput.value = url;
    }

    // Basic validation
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      setTranslatedText(joinError, 'welcome.error.invalidUrl');
      joinError.style.display = 'block';
      return;
    }

    // Strip to origin (protocol + host + port) — prevents double-path issues
    // e.g. "https://174.49.177.46:3000/app" → "https://174.49.177.46:3000"
    const serverUrl = parsed.origin;
    urlInput.value = serverUrl;

    connectBtn.disabled    = true;
    setTranslatedText(connectBtn, 'welcome.connecting');

    try {
      // Quick health check — try to reach the server
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(serverUrl + '/api/health', {
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeout);

      if (!res || !res.ok) {
        setTranslatedText(joinError, 'welcome.error.serverUnreachable');
        joinError.style.display = 'block';
        return;
      }

      const remember = $('#chk-remember').checked;

      // Merge with existing prefs to preserve audioInput, serverPath, etc.
      const existing = await window.haven.settings.get('userPrefs') || {};
      await window.haven.settings.set('userPrefs', {
        ...existing,
        mode: 'join',
        serverUrl: serverUrl,
        skipWelcome: remember,
      });

      window.haven.nav.openApp(serverUrl);

    } catch (err) {
      setTranslatedText(joinError, 'welcome.error.connectionFailed');
      joinError.style.display = 'block';
    } finally {
      connectBtn.disabled    = false;
      setTranslatedText(connectBtn, 'welcome.connect');
    }
  };

})();
