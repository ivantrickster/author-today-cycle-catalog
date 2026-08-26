(async () => {
  const consentKey = chrome.extension?.inIncognitoContext ? 'incognito:privacyConsent' : 'privacyConsent';
  const consentState = await chrome.storage.local.get({ [consentKey]: null });
  if (consentState[consentKey]?.version !== 1) return;

  document.getElementById('at-cycle-catalog-widget')?.remove();
  const widget = document.createElement('aside');
  widget.id = 'at-cycle-catalog-widget';
  widget.innerHTML = `
    <button id="at-cycle-trigger" type="button" aria-expanded="false">
      <span class="at-cycle-mark">AT</span><span id="at-cycle-trigger-label">Рейтинг цикла</span>
    </button>
    <section id="at-cycle-panel" hidden>
      <div id="at-cycle-loading">Собираю статистику…</div>
      <div id="at-cycle-result" hidden></div>
    </section>`;
  document.body.append(widget);

  const trigger = widget.querySelector('#at-cycle-trigger');
  const panel = widget.querySelector('#at-cycle-panel');
  let cycle = null;
  let inCatalog = false;
  let loaded = false;

  trigger.onclick = async () => {
    panel.hidden = !panel.hidden;
    trigger.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden && !loaded) await loadCycle();
  };

  async function loadCycle(force = false) {
    const loading = widget.querySelector('#at-cycle-loading');
    const result = widget.querySelector('#at-cycle-result');
    loading.hidden = false;
    loading.textContent = force ? 'Обновляю статистику…' : 'Собираю статистику…';
    result.hidden = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'analyzeCurrentCycle', url: location.href, force });
      if (response.status === 'standalone') {
        loading.textContent = 'Это произведение не входит в цикл.';
        loaded = true;
        return;
      }
      if (response.status !== 'ready' || !response.cycle) throw new Error(response.error || 'Не удалось получить статистику.');
      cycle = response.cycle;
      inCatalog = Boolean(response.inCatalog);
      loaded = true;
      render();
      loading.hidden = true;
      result.hidden = false;
    } catch (error) {
      loading.textContent = error.message || 'Не удалось получить статистику.';
    }
  }

  function selectedScore() {
    return cycle?.scores?.finishedFromSecond || cycle?.score || {};
  }

  function render() {
    const score = selectedScore();
    widget.querySelector('#at-cycle-trigger-label').textContent = `Рейтинг ${score.value ?? '—'}`;
    const result = widget.querySelector('#at-cycle-result');
    result.innerHTML = `
      <header>
        <div><a href="${cycle.url}" target="_blank">${escapeText(cycle.title)}</a><small>${escapeText(cycle.author || 'Автор не указан')}</small></div>
        <strong>${score.value ?? '—'}${score.recentTerminalVolume ? '<em title="Последний том вышел недавно">◷</em>' : ''}</strong>
      </header>
      <div class="at-cycle-metrics">
        <span>Аудитория <b>${formatPercent(score.audienceRetention)}</b></span>
        <span>Лайки <b>${formatPercent(score.likeRetention)}</b></span>
      </div>
      <footer>
        <button id="at-cycle-refresh" type="button" title="Обновить статистику" aria-label="Обновить статистику">↻</button>
        <button id="at-cycle-star" type="button" class="${inCatalog ? 'active' : ''}" aria-pressed="${inCatalog}" aria-label="${inCatalog ? 'Убрать из избранного' : 'Добавить в избранное'}" title="${inCatalog ? 'Убрать из избранного' : 'Добавить в избранное'}" data-tooltip="${inCatalog ? 'Убрать из избранного' : 'Добавить в избранное'}">${inCatalog ? '★' : '☆'}</button>
        <button id="at-cycle-info" type="button" title="Как считается рейтинг" aria-label="Как считается рейтинг">i</button>
      </footer>`;
    result.querySelector('#at-cycle-refresh').onclick = () => loadCycle(true);
    result.querySelector('#at-cycle-star').onclick = toggleCatalog;
    result.querySelector('#at-cycle-info').onclick = () => chrome.runtime.sendMessage({ type: 'openRatingInfo' });
  }

  async function toggleCatalog() {
    if (!cycle) return;
    if (inCatalog) {
      await chrome.runtime.sendMessage({ type: 'removeCycle', url: cycle.url });
      inCatalog = false;
    } else {
      const response = await chrome.runtime.sendMessage({ type: 'addSearchCycle', seriesId: cycle.seriesId });
      if (!response.added && response.reason !== 'exists') return;
      inCatalog = true;
    }
    render();
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  }

  function escapeText(value) {
    const element = document.createElement('span');
    element.textContent = value ?? '';
    return element.innerHTML;
  }
})();
