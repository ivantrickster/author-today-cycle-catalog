const $ = selector => document.querySelector(selector);
let currentUrl = '';
let currentCycle = null;
let inCatalog = false;

$('#catalog').onclick = () => openExtensionPage('popup.html');
$('#search').onclick = () => openExtensionPage('search.html');

function selectedScore() {
  return currentCycle?.scores?.finishedFromSecond || currentCycle?.score || {};
}

async function activeAuthorPageUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const match = String(tab?.url || '').match(/^https:\/\/author\.today\/work\/(?:series\/\d+|\d+)(?:[/?#]|$)/i);
  return match?.[0] || '';
}

async function loadCycle(force = false) {
  setLoading(true);
  showNotice('');
  try {
    currentUrl = await activeAuthorPageUrl();
    if (!currentUrl) {
      currentCycle = null;
      showNotice('Откройте страницу произведения или цикла Author.Today.', true);
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'analyzeCurrentCycle', url: currentUrl, force });
    if (response.status === 'paused') throw new Error(`Author.Today временно ограничил запросы до ${new Date(response.until).toLocaleString()}.`);
    if (response.status === 'standalone') {
      currentCycle = null;
      showNotice(`«${response.bookTitle || 'Это произведение'}» не входит в цикл.`);
      return;
    }
    if (response.status !== 'ready' || !response.cycle) throw new Error(response.error || 'Не удалось получить данные цикла.');
    currentCycle = response.cycle;
    inCatalog = Boolean(response.inCatalog);
    $('#cycle').hidden = false;
    renderCycle();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setLoading(false);
  }
}

async function toggleCatalog() {
  if (!currentCycle) return;
  const star = $('#catalogToggle');
  star.disabled = true;
  try {
    if (inCatalog) {
      await chrome.runtime.sendMessage({ type: 'removeCycle', url: currentCycle.url });
      inCatalog = false;
    } else {
      const result = await chrome.runtime.sendMessage({ type: 'addSearchCycle', seriesId: currentCycle.seriesId });
      if (!result.added && result.reason !== 'exists') throw new Error('Не удалось добавить цикл.');
      inCatalog = true;
    }
    updateCatalogButton();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    star.disabled = false;
  }
}

function updateCatalogButton() {
  const button = $('#catalogToggle');
  if (!button) return;
  const hint = inCatalog ? 'Убрать из избранного' : 'Добавить в избранное';
  button.classList.toggle('active', inCatalog);
  button.textContent = inCatalog ? '★' : '☆';
  button.title = hint;
  button.dataset.tooltip = hint;
  button.setAttribute('aria-label', hint);
  button.setAttribute('aria-pressed', String(inCatalog));
}

function renderCycle() {
  if (!currentCycle) return;
  const score = selectedScore();
  const finished = currentCycle.books.filter(book => book.isFinished !== false).length;
  const genres = (currentCycle.genres || []).slice(0, 3);
  const fresh = score.recentTerminalVolume
    ? '<span class="score-fresh" title="Последний учтённый том вышел недавно. Оценка может измениться.">◷</span>'
    : '';
  $('#cycle').innerHTML = `<article class="cycle-card">
    <div class="card-tools">
      <button id="refresh" class="icon-button" type="button" title="Обновить статистику" aria-label="Обновить статистику">↻</button>
      <button id="catalogToggle" class="icon-button star-button" type="button"></button>
      <button id="copyImage" class="icon-button" type="button" title="Скопировать карточку" aria-label="Скопировать карточку">⧉</button>
      <button id="showInfo" class="info-button" type="button" title="О расчёте" aria-label="О расчёте">i</button>
    </div>
    <div class="heading">
      <div><a class="title" href="${currentCycle.url}" target="_blank">${escapeHtml(currentCycle.title)}</a><div class="author">${escapeHtml(currentCycle.author || 'Автор не указан')}</div></div>
      <div class="score-wrap"><strong class="score">${score.value ?? '—'}</strong>${fresh}</div>
    </div>
    <div class="meta"><span class="tag">${currentCycle.status === 'completed' ? 'цикл завершён' : 'цикл в процессе'}</span> · ${currentCycle.books.length} томов · завершено ${finished}${currentCycle.durationLabel && currentCycle.durationLabel !== '—' ? ` · ${escapeHtml(currentCycle.durationLabel)}` : ''}</div>
    ${genres.length ? `<div class="genres">${genres.map(genre => `<span>${escapeHtml(genre)}</span>`).join('')}</div>` : ''}
    <div class="metrics">
      ${metric('Аудитория', score.audienceRetention, `${count(score.baselineLibraries)} → ${count(score.lastLibraries)}`)}
      ${metric('Лайки', score.likeRetention, `${count(score.baselineLikes)} → ${count(score.lastLikes)}`)}
      ${metric('Комментарии', null, count(score.lastComments), true)}
    </div>
    ${scoreContext(score)}
  </article>`;
  $('#refresh').onclick = () => loadCycle(true);
  $('#catalogToggle').onclick = toggleCatalog;
  $('#copyImage').onclick = copyImage;
  $('#showInfo').onclick = () => openExtensionPage('rating.html');
  updateCatalogButton();
}

async function copyImage() {
  const button = $('#copyImage');
  button.disabled = true;
  try {
    await copyCycleCardImage(currentCycle, selectedScore());
    showNotice('Карточка скопирована как изображение.');
  } catch {
    const report = diagnosticReport(currentCycle, selectedScore());
    await navigator.clipboard.writeText(report);
    showNotice('Изображение недоступно — скопирован текстовый отчёт.');
  } finally {
    button.disabled = false;
  }
}

function metric(label, value, detail, neutral = false) {
  const tone = neutral ? '' : Number.isFinite(value) && value >= .65 ? 'good' : 'bad';
  return `<div class="metric"><div class="metric-label">${label}</div><strong class="${tone}">${neutral ? detail : percent(value)}</strong>${neutral ? '' : `<small>${detail}</small>`}</div>`;
}

function showNotice(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle('error', error);
}

function setLoading(busy) {
  $('#loading').hidden = !busy;
  if (busy) {
    $('#cycle').hidden = true;
  }
}

async function initialize() {
  await loadCycle();
}

requirePrivacyConsent().then(accepted => { if (accepted) initialize(); });
