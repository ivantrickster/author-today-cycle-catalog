const $ = selector => document.querySelector(selector);
const expandedDynamics = new Set();
let preferences = null;
let latestState = null;
setupChartTooltip();

$('#search').onclick = () => openExtensionPage('search.html');
$('#ratingInfo').onclick = () => openExtensionPage('rating.html');
$('#import').onclick = importCycles;
$('#show').onclick = refreshAll;
$('#clear').onclick = clearCatalog;
$('#sortDirection').onclick = toggleSortDirection;
for (const id of ['status', 'sortBy', 'minAudienceRetention', 'minLikeRetention']) {
  $('#' + id).addEventListener('input', onPreferencesChanged);
}

function selectedScore(cycle) {
  return cycle.scores?.finishedFromSecond || cycle.score || {};
}

async function onPreferencesChanged() {
  preferences = await chrome.runtime.sendMessage({
    type: 'saveUiPreferences',
    preferences: {
      catalog: catalogPreferences()
    }
  });
  render();
}

function catalogPreferences() {
  return {
    status: $('#status').value,
    minAudienceRetention: $('#minAudienceRetention').value,
    minLikeRetention: $('#minLikeRetention').value,
    sortBy: $('#sortBy').value,
    sortDirection: $('#sortDirection').value
  };
}

async function toggleSortDirection() {
  const button = $('#sortDirection');
  button.value = button.value === 'asc' ? 'desc' : 'asc';
  updateDirectionButton();
  await onPreferencesChanged();
}

function updateDirectionButton() {
  const button = $('#sortDirection');
  const ascending = button.value === 'asc';
  button.textContent = ascending ? '↑' : '↓';
  button.setAttribute('aria-label', ascending ? 'По возрастанию' : 'По убыванию');
}

async function importCycles() {
  const result = await chrome.runtime.sendMessage({ type: 'importUrls', urls: $('#urls').value.split(/\s+/) });
  $('#urls').value = '';
  $('#notice').textContent = result.added ? 'Добавлено: ' + result.added : 'Новых ссылок нет';
  document.querySelector('.more-menu').open = false;
  render();
}

async function refreshAll() {
  const button = $('#show');
  button.disabled = true;
  $('#notice').textContent = 'Обновляю…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'refresh' });
    $('#notice').textContent = result.status === 'paused' ? 'Сбор временно приостановлен'
      : result.status === 'empty' ? 'Всё актуально' : result.status === 'error' ? 'Ошибка обновления' : 'Обновлено';
    await render();
  } finally {
    button.disabled = false;
  }
}

async function clearCatalog() {
  if (!confirm('Удалить все циклы и очередь сбора? Это нельзя отменить.')) return;
  await chrome.runtime.sendMessage({ type: 'clearCatalog' });
  expandedDynamics.clear();
  document.querySelector('.more-menu').open = false;
  $('#notice').textContent = 'Каталог очищен';
  render();
}

async function removeCycle(url) {
  await chrome.runtime.sendMessage({ type: 'removeCycle', url });
  $('#notice').textContent = 'Цикл удалён';
  render();
}

function sortCycles(cycles) {
  const sortBy = $('#sortBy').value;
  const direction = $('#sortDirection').value === 'asc' ? 1 : -1;
  return cycles.sort((a, b) => {
    if (sortBy === 'title') return direction * String(a.title || '').localeCompare(String(b.title || ''), 'ru');
    const aScore = selectedScore(a), bScore = selectedScore(b);
    const values = {
      rating: [aScore.value, bScore.value],
      audience: [aScore.audienceRetention, bScore.audienceRetention],
      likes: [aScore.likeRetention, bScore.likeRetention],
      comments: [aScore.lastComments, bScore.lastComments],
      books: [a.books?.length, b.books?.length],
      updated: [Date.parse(a.updatedAt), Date.parse(b.updatedAt)]
    }[sortBy] || [aScore.value, bScore.value];
    const left = Number.isFinite(values[0]) ? values[0] : -Infinity;
    const right = Number.isFinite(values[1]) ? values[1] : -Infinity;
    return direction * (left - right);
  });
}

async function render() {
  latestState = await chrome.runtime.sendMessage({ type: 'getState' });
  $('#queue').textContent = latestState.pausedUntil > Date.now()
    ? 'Пауза до ' + new Date(latestState.pausedUntil).toLocaleString()
    : latestState.queue.length ? 'Ожидают обновления: ' + latestState.queue.length
      : 'Циклов: ' + latestState.cycles.length;
  const status = $('#status').value;
  const minAudience = Number($('#minAudienceRetention').value || 0) / 100;
  const minLikes = Number($('#minLikeRetention').value || 0) / 100;
  const cycles = sortCycles(latestState.cycles.filter(cycle => {
    const score = selectedScore(cycle);
    return (status === 'all' || cycle.status === status)
      && (!minAudience || (Number.isFinite(score.audienceRetention) && score.audienceRetention >= minAudience))
      && (!minLikes || (Number.isFinite(score.likeRetention) && score.likeRetention >= minLikes));
  }));
  $('#list').innerHTML = cycles.length ? cycles.map(renderCard).join('') : '<p class="empty">Нет циклов с такими параметрами.</p>';
  bindCardActions();
}

function renderCard(cycle) {
  const score = selectedScore(cycle);
  const seriesId = Number(cycle.seriesId) || Number(/\/series\/(\d+)/.exec(cycle.url || '')?.[1]) || 0;
  const finished = cycle.books.filter(book => book.isFinished !== false).length;
  const genres = (cycle.genres || []).slice(0, 3);
  const fresh = score.recentTerminalVolume ? '<span class="score-fresh" title="Последний учтённый том вышел недавно">◷</span>' : '';
  const expanded = expandedDynamics.has(seriesId);
  const genreLine = genres.length ? '<div class="genre-tags">' + genres.map(genre => '<span>' + escapeHtml(genre) + '</span>').join('') + '</div>' : '';
  const duration = cycle.durationLabel && cycle.durationLabel !== '—' ? ' · ' + escapeHtml(cycle.durationLabel) : '';
  const context = score.insufficientBooks ? '<div class="score-context result-bad">Недостаточно данных для рейтинга</div>' : scoreContext(score);
  return '<article class="card">'
    + '<div class="row"><div><a class="title" href="' + cycle.url + '" target="_blank">' + escapeHtml(cycle.title) + '</a><div class="author">' + escapeHtml(cycle.author || 'Автор не указан') + '</div></div></div>'
    + '<div class="score-wrap"><strong class="score">' + (score.value ?? '—') + '</strong>' + fresh + '</div>'
    + '<div class="meta"><span class="tag">' + (cycle.status === 'completed' ? 'завершён' : 'в процессе') + '</span> · ' + cycle.books.length + ' томов · завершено ' + finished + duration + '</div>'
    + genreLine
    + '<div class="metrics-block">'
    + catalogMetric('Аудитория', percent(score.audienceRetention), count(score.baselineLibraries) + ' → ' + count(score.lastLibraries), score.audienceRetention)
    + catalogMetric('Лайки', percent(score.likeRetention), count(score.baselineLikes) + ' → ' + count(score.lastLikes), score.likeRetention)
    + catalogMetric('Комментарии', count(score.lastComments), 'том №' + (score.lastBook || '—'), null)
    + context + '</div>'
    + '<div class="card-actions">'
    + '<button class="show-dynamics" data-id="' + seriesId + '" data-url="' + cycle.url + '" title="Динамика" aria-label="Динамика">⌁</button>'
    + '<button class="copy-image" data-id="' + seriesId + '" title="Скопировать карточку" aria-label="Скопировать карточку">⧉</button>'
    + '<button class="copy-diagnostic" data-id="' + seriesId + '" title="Скопировать диагностический отчёт" aria-label="Скопировать диагностический отчёт">i</button>'
    + '<button class="remove" data-url="' + cycle.url + '" title="Удалить цикл" aria-label="Удалить цикл">×</button></div>'
    + '<div class="dynamics" data-dynamics-id="' + seriesId + '"' + (expanded ? '' : ' hidden') + '>' + (expanded ? renderDynamics(cycle, score, { compact: true }) : '') + '</div>'
    + '</article>';
}

function catalogMetric(label, value, detail, retention) {
  const tone = Number.isFinite(retention) ? (retention >= .65 ? 'good' : 'bad') : '';
  return '<div class="metric">' + label + '<b class="' + tone + '">' + value + '</b><span class="counts">' + detail + '</span></div>';
}

function bindCardActions() {
  document.querySelectorAll('.remove').forEach(button => button.onclick = () => removeCycle(button.dataset.url));
  document.querySelectorAll('.show-dynamics').forEach(button => button.onclick = () => toggleDynamics(Number(button.dataset.id), button.dataset.url, button));
  document.querySelectorAll('.copy-image').forEach(button => button.onclick = () => copyImage(Number(button.dataset.id), button));
  document.querySelectorAll('.copy-diagnostic').forEach(button => button.onclick = () => copyDiagnostic(Number(button.dataset.id)));
}

async function copyImage(seriesId, button) {
  const cycle = latestState.cycles.find(item => Number(item.seriesId) === seriesId);
  if (!cycle) return;
  button.disabled = true;
  try {
    await copyCycleCardImage(cycle, selectedScore(cycle));
    $('#notice').textContent = 'Карточка скопирована';
  } catch {
    await navigator.clipboard.writeText(diagnosticReport(cycle, selectedScore(cycle)));
    $('#notice').textContent = 'Скопирован текстовый отчёт';
  } finally {
    button.disabled = false;
  }
}

async function copyDiagnostic(seriesId) {
  const cycle = latestState.cycles.find(item => Number(item.seriesId) === seriesId);
  if (!cycle) return;
  await navigator.clipboard.writeText(diagnosticReport(cycle, selectedScore(cycle)));
  $('#notice').textContent = 'Диагностический отчёт скопирован';
}

async function toggleDynamics(seriesId, url, button) {
  const panel = document.querySelector('[data-dynamics-id="' + seriesId + '"]');
  if (!panel) return;
  if (!panel.hidden) {
    expandedDynamics.delete(seriesId);
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = '<div class="chart-loading">Загружаю данные по томам…</div>';
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getCycleDynamics', seriesId, url });
    if (response.status !== 'ready' || !response.cycle) throw new Error(response.error || 'данные цикла не найдены');
    expandedDynamics.add(seriesId);
    panel.innerHTML = renderDynamics(response.cycle, selectedScore(response.cycle), { compact: true });
  } catch (error) {
    panel.innerHTML = '<div class="chart-loading chart-error">Не удалось загрузить динамику: ' + escapeHtml(error.message) + '</div>';
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  preferences = await chrome.runtime.sendMessage({ type: 'getUiPreferences' });
  $('#status').value = preferences.catalog.status;
  $('#minAudienceRetention').value = preferences.catalog.minAudienceRetention;
  $('#minLikeRetention').value = preferences.catalog.minLikeRetention;
  $('#sortBy').value = preferences.catalog.sortBy;
  $('#sortDirection').value = preferences.catalog.sortDirection;
  updateDirectionButton();
  await render();
}

requirePrivacyConsent().then(accepted => { if (accepted) initialize(); });
