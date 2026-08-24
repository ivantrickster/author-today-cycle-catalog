const $ = selector => document.querySelector(selector);
let statsVisible = true;
const expandedDynamics = new Set();
let manualCycleOrder = null;
setupChartTooltip();

$('#search').onclick = () => openExtensionPage('search.html');
$('#import').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'importUrls', urls: $('#urls').value.split(/\s+/) });
  $('#urls').value = '';
  $('#notice').textContent = result.added ? `Добавлено циклов: ${result.added}. Нажмите «Обновить статистику», чтобы собрать данные.` : 'Новых корректных ссылок не найдено.';
  render();
};
$('#show').onclick = async () => {
  statsVisible = true;
  $('#list').hidden = false; $('#filters').hidden = false;
  $('#notice').textContent = 'Обновляю статистику…';
  const result = await chrome.runtime.sendMessage({ type: 'refresh' });
  $('#notice').textContent = result.status === 'scanned' ? 'Статистика обновлена и сохранена.' : result.status === 'paused' ? 'API временно ограничил запросы. Сбор приостановлен.' : result.status === 'empty' ? 'Статистика уже актуальна.' : `Не удалось обработать цикл: ${result.error || 'неизвестная ошибка'}`;
  render();
};
$('#sortRating').onclick = async () => {
  const state = await chrome.runtime.sendMessage({ type: 'getState' });
  manualCycleOrder = [...state.cycles]
    .sort((a, b) => (selectedScore(b).value ?? -1) - (selectedScore(a).value ?? -1))
    .map(cycleKey);
  $('#notice').textContent = 'Циклы отсортированы по текущему рейтингу. Порядок останется фиксированным при изменении фильтров.';
  render();
};
$('#clear').onclick = async () => {
  if (!confirm('Удалить все циклы и очередь сбора? Это нельзя отменить.')) return;
  await chrome.runtime.sendMessage({ type: 'clearCatalog' });
  expandedDynamics.clear();
  manualCycleOrder = null;
  statsVisible = true; $('#list').hidden = false; $('#filters').hidden = false;
  $('#notice').textContent = 'Каталог очищен.'; render();
};
['status', 'minAudienceRetention', 'minLikeRetention', 'fromSecond', 'finishedOnly'].forEach(id => $(`#${id}`).addEventListener('input', render));

function date(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('ru-RU') : '—'; }
async function copyReport(cycle, score) {
  const text = diagnosticReport(cycle, score);
  try { await navigator.clipboard.writeText(text); }
  catch { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
  $('#notice').textContent = 'Диагностический отчёт скопирован.';
}
function selectedScore(cycle) {
  const fromSecond = $('#fromSecond').checked;
  const finishedOnly = $('#finishedOnly').checked;
  const key = finishedOnly ? (fromSecond ? 'finishedFromSecond' : 'finished') : (fromSecond ? 'fromSecond' : 'default');
  return cycle.scores?.[key] || cycle.score || {};
}
function cycleKey(cycle) { return String(Number(cycle.seriesId) || cycle.url || ''); }
async function removeCycle(url) { await chrome.runtime.sendMessage({ type: 'removeCycle', url }); $('#notice').textContent = 'Цикл удалён из каталога.'; render(); }
async function render() {
  const state = await chrome.runtime.sendMessage({ type: 'getState' });
  $('#queue').textContent = state.pausedUntil > Date.now() ? `Сбор приостановлен до ${new Date(state.pausedUntil).toLocaleString()}` : state.queue.length ? `Ожидают сбора: ${state.queue.length}` : state.cycles.length ? `В каталоге: ${state.cycles.length}` : 'Каталог пока пуст.';
  if (!statsVisible) return;
  const status = $('#status').value;
  const minAudienceRetention = Number($('#minAudienceRetention').value || 0) / 100;
  const minLikeRetention = Number($('#minLikeRetention').value || 0) / 100;
  const storageOrder = new Map(state.cycles.map((cycle, index) => [cycleKey(cycle), index]));
  const manualOrder = new Map((manualCycleOrder || []).map((key, index) => [key, index]));
  const cycles = state.cycles.filter(cycle => {
    const score = selectedScore(cycle);
    return (status === 'all' || cycle.status === status)
      && (minAudienceRetention === 0 || (Number.isFinite(score.audienceRetention) && score.audienceRetention > minAudienceRetention))
      && (minLikeRetention === 0 || (Number.isFinite(score.likeRetention) && score.likeRetention > minLikeRetention));
  });
  if (manualCycleOrder) cycles.sort((a, b) => {
    const aKey = cycleKey(a), bKey = cycleKey(b);
    const aPosition = manualOrder.has(aKey) ? manualOrder.get(aKey) : manualCycleOrder.length + storageOrder.get(aKey);
    const bPosition = manualOrder.has(bKey) ? manualOrder.get(bKey) : manualCycleOrder.length + storageOrder.get(bKey);
    return aPosition - bPosition;
  });
  $('#list').innerHTML = cycles.length ? cycles.map(cycle => {
    const score = selectedScore(cycle);
    const seriesId = Number(cycle.seriesId) || Number(/\/series\/(\d+)/.exec(cycle.url || '')?.[1]) || 0;
    const finished = cycle.books.filter(book => book.isFinished !== false).length;
    const anomalyNote = scoreNotes(score);
    const genres = (cycle.genres || []).slice(0, 3);
    const genreLine = genres.length ? `<div class="genre-tags" aria-label="Жанры первого тома">${genres.map(genre => `<span>${escapeHtml(genre)}</span>`).join('')}</div>` : '';
    const discussionLine = `<div class="discussion-reference"><strong>Комментарии · справочно</strong><span>Том №${score.baselineBook || 1}: ${count(score.baselineComments)} · том №${score.lastBook || '—'}: ${count(score.lastComments)}</span><small>Один читатель может написать несколько комментариев, поэтому они не влияют на рейтинг.</small></div>`;
    const durationHint = `От первой публикации первого тома (${date(cycle.cycleStartedAt)}) до последнего обновления последнего тома (${date(cycle.cycleLastUpdatedAt)}). Фильтры на длину цикла не влияют.`;
    const durationMeta = cycle.durationLabel && cycle.durationLabel !== '—' ? ` · длина цикла <span title="${durationHint}">${cycle.durationLabel}</span>` : '';
    const dynamicsExpanded = expandedDynamics.has(seriesId);
    const dynamicsContent = dynamicsExpanded ? renderDynamics(cycle, score) : '';
    return `<article class="card"><div class="card-top"><div class="row"><a class="title" href="${cycle.url}" target="_blank">${escapeHtml(cycle.title)}</a><strong class="score" title="${ratingHint(score)}">${score.value ?? '—'}</strong></div><div class="author">${escapeHtml(cycle.author || 'Автор не указан')}</div><div class="meta"><span class="tag">${cycle.status === 'completed' ? 'цикл завершён' : 'цикл в процессе'}</span> ${cycle.books.length} томов · завершено ${finished}${durationMeta}</div>${genreLine}${anomalyNote}</div><div class="metrics-block"><div class="retention">Аудитория к последнему учтённому тому: <b class="${(score.audienceRetention ?? 0) >= .65 ? 'good' : 'bad'}">${percent(score.audienceRetention)}</b> <span class="counts">(${count(score.baselineLibraries)} → ${count(score.lastLibraries)} добавлений)</span></div><div class="retention">Лайки к последнему учтённому тому: <b class="${(score.likeRetention ?? 0) >= .65 ? 'good' : 'bad'}">${percent(score.likeRetention)}</b> <span class="counts">(${count(score.baselineLikes)} → ${count(score.lastLikes)})</span></div>${scoreContext(score)}${discussionLine}</div><div class="card-actions"><button class="show-dynamics" data-id="${seriesId}" data-url="${cycle.url}">${dynamicsExpanded ? 'Скрыть динамику' : 'Показать динамику'}</button><button class="copy-report" data-id="${seriesId}">Скопировать отчёт</button><button class="remove" data-url="${cycle.url}">Удалить цикл</button></div><div class="dynamics" data-dynamics-id="${seriesId}"${dynamicsExpanded ? '' : ' hidden'}>${dynamicsContent}</div></article>`;
  }).join('') : '<p class="hint">Нет циклов, соответствующих выбранным фильтрам.</p>';
  document.querySelectorAll('.remove').forEach(button => button.onclick = () => removeCycle(button.dataset.url));
  document.querySelectorAll('.show-dynamics').forEach(button => button.onclick = () => toggleDynamics(Number(button.dataset.id), button.dataset.url, button));
  document.querySelectorAll('.copy-report').forEach(button => button.onclick = () => {
    const cycle = state.cycles.find(item => Number(item.seriesId) === Number(button.dataset.id));
    if (cycle) copyReport(cycle, selectedScore(cycle));
  });
  requestAnimationFrame(alignCatalogRows);
}

function alignCatalogRows() {
  const cards = [...document.querySelectorAll('#list .card')];
  for (const selector of ['.card-top', '.metrics-block', '.card-actions']) {
    const elements = cards.map(card => card.querySelector(selector)).filter(Boolean);
    elements.forEach(element => element.style.minHeight = '');
  }
  const rows = [];
  for (const card of cards) {
    const top = Math.round(card.offsetTop);
    let row = rows.find(item => Math.abs(item.top - top) <= 1);
    if (!row) { row = { top, cards: [] }; rows.push(row); }
    row.cards.push(card);
  }
  for (const row of rows) {
    for (const selector of ['.card-top', '.metrics-block', '.card-actions']) {
      const elements = row.cards.map(card => card.querySelector(selector)).filter(Boolean);
      const height = Math.max(0, ...elements.map(element => element.offsetHeight));
      elements.forEach(element => element.style.minHeight = `${height}px`);
    }
  }
}

window.addEventListener('resize', () => requestAnimationFrame(alignCatalogRows));

async function toggleDynamics(seriesId, url, button) {
  const panel = document.querySelector(`[data-dynamics-id="${seriesId}"]`);
  if (!panel) return;
  if (!panel.hidden) {
    expandedDynamics.delete(seriesId);
    panel.hidden = true;
    button.textContent = 'Показать динамику';
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
    button.textContent = 'Скрыть динамику';
  } catch (error) {
    panel.innerHTML = `<div class="chart-loading chart-error">Не удалось загрузить динамику: ${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

requirePrivacyConsent().then(accepted => { if (accepted) render(); });
