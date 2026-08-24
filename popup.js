const $ = selector => document.querySelector(selector);
let statsVisible = true;
const expandedDynamics = new Set();
let manualCycleOrder = null;
const chartTooltip = document.createElement('div');
chartTooltip.className = 'chart-tooltip';
chartTooltip.hidden = true;
document.body.append(chartTooltip);

document.addEventListener('pointerover', event => {
  const point = event.target.closest?.('.chart-point[data-tooltip]');
  if (!point) return;
  chartTooltip.textContent = point.dataset.tooltip;
  chartTooltip.hidden = false;
  positionChartTooltip(event.clientX, event.clientY);
});
document.addEventListener('pointermove', event => {
  if (!chartTooltip.hidden && event.target.closest?.('.chart-point[data-tooltip]')) positionChartTooltip(event.clientX, event.clientY);
});
document.addEventListener('pointerout', event => {
  if (event.target.closest?.('.chart-point[data-tooltip]')) chartTooltip.hidden = true;
});

function positionChartTooltip(clientX, clientY) {
  const gap = 12;
  const bounds = chartTooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(clientX + gap, window.innerWidth - bounds.width - 8));
  const below = clientY + gap;
  const top = below + bounds.height <= window.innerHeight - 8 ? below : Math.max(8, clientY - bounds.height - gap);
  chartTooltip.style.left = `${left}px`;
  chartTooltip.style.top = `${top}px`;
}

$('#search').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('search.html') });
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

function percent(value) { return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'; }
function count(value) { return Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—'; }
function decimal(value) { return Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—'; }
function date(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('ru-RU') : '—'; }
function plural(value, forms) { const tens = value % 100, units = value % 10; return tens >= 11 && tens <= 14 ? forms[2] : units === 1 ? forms[0] : units >= 2 && units <= 4 ? forms[1] : forms[2]; }
function durationMonths(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1) return 'менее месяца';
  const months = Math.max(1, Math.round(value));
  const years = Math.floor(months / 12), remainder = months % 12;
  const parts = [];
  if (years) parts.push(`${years} ${plural(years, ['год', 'года', 'лет'])}`);
  if (remainder) parts.push(`${remainder} ${plural(remainder, ['месяц', 'месяца', 'месяцев'])}`);
  return parts.join(' ');
}
function ratingHint(score) {
  const adjustment = score.chronologyAdjusted ? `\nТом №${score.excludedChronologyBooks.join(', №')} исключён: дата публикации нарушает порядок томов.` : '';
  const volume = score.volumeAdjusted ? `\nТом №${score.excludedVolumeBooks.join(', №')} исключён: объём меньше 35% медианного объёма томов цикла.` : '';
  const growth = score.growthDetected ? '\nЗначения выше 100% показывают рост; дополнительных баллов за них нет.' : '';
  const transfer = score.possibleAudienceTransfer ? '\nВозможен перенос аудитории: первые два тома размещены с интервалом не более двух дней.' : '';
  const finale = score.finaleCommentSpike ? `\nУ тома №${score.finaleCommentSpike.bookNumber} отмечен необычный объём обсуждения финала.` : '';
  if (score.insufficientBooks) return `Рейтинг не рассчитан: нужно минимум ${score.minimumBooksRequired || 3} тома в расчёте. Сейчас: ${score.includedCount || 0}.${volume}${adjustment}`;
  return `Рейтинг: ${score.value ?? '—'} из 100.\n50 — обычный результат для цикла такой длины и продолжительности.\nАудитория: ${score.audiencePoints ?? 0} из 60 баллов (${percent(score.audienceRetention)} при обычных ${percent(score.expectedAudienceRetention)}).\nЛайки: ${score.likePoints ?? 0} из 40 баллов (${percent(score.likeRetention)} при обычных ${percent(score.expectedLikeRetention)}).\nКомментарии и лайки на 100 добавлений на рейтинг не влияют.${finale}${growth}${transfer}${volume}${adjustment}`;
}
function scoreNotes(score) {
  const notes = [];
  if (score.insufficientBooks) notes.push(`<div class="anomaly-note error-note"><strong>Недостаточно данных для рейтинга.</strong> Нужно хотя бы ${score.minimumBooksRequired || 3} подходящих тома, сейчас — ${score.includedCount || 0}.</div>`);
  if (score.recentTerminalVolume) notes.push('<div class="anomaly-note"><strong>Последний том вышел недавно.</strong> Его показатели ещё могут вырасти.</div>');
  if (score.modelExtrapolated) notes.push('<div class="anomaly-note"><strong>Цикл длиннее большинства проверенных.</strong> Поправка ограничена, чтобы не завысить рейтинг.</div>');
  if (score.modelDatesComplete === false) notes.push('<div class="anomaly-note"><strong>Не хватает дат публикации.</strong> Рейтинг рассчитан без поправки на время.</div>');
  if (score.finaleCommentSpike) {
    const spike = score.finaleCommentSpike;
    notes.push(`<div class="anomaly-note finale-note"><strong>Финал обсуждали особенно активно.</strong> В томе №${spike.bookNumber} намного больше комментариев, чем обычно. На рейтинг это не влияет.</div>`);
  }
  if (score.growthDetected) {
    const parts = [];
    if (Number.isFinite(score.audienceRetention) && score.audienceRetention > 1) parts.push(`аудитория +${Math.round((score.audienceRetention - 1) * 100)}%`);
    if (Number.isFinite(score.likeRetention) && score.likeRetention > 1) parts.push(`лайки +${Math.round((score.likeRetention - 1) * 100)}%`);
    notes.push(`<div class="anomaly-note growth-note"><strong>К последнему тому показатели выросли:</strong> ${parts.join(', ')}. Максимальный рейтинг всё равно ограничен 100 баллами.</div>`);
  }
  if (score.possibleAudienceTransfer) notes.push('<div class="anomaly-note"><strong>Первые два тома появились почти одновременно.</strong> Рост показателей может быть связан с переносом аудитории между ними.</div>');
  if (score.volumeAdjusted) {
    for (const item of score.volumeAnomalies || []) notes.push(`<div class="anomaly-note"><strong>Том №${item.bookNumber} не учитывается:</strong> он заметно короче остальных (${count(item.textLength)} знаков). Возможно, это ответвление сюжета или заметки автора.</div>`);
  }
  if (score.chronologyAdjusted) notes.push(`<div class="anomaly-note"><strong>Том №${score.excludedChronologyBooks.join(', №')} не учитывается:</strong> он опубликован не по порядку.${score.adjustedBaseline ? ` Сравнение начинается с тома №${score.baselineBook}.` : ''}</div>`);
  return notes.join('');
}

function scoreContext(score) {
  if (score.insufficientBooks) return '';
  const comparison = score.value >= 80 ? 'намного выше обычного'
    : score.value >= 60 ? 'выше обычного'
      : score.value >= 40 ? 'примерно как у похожих циклов'
        : score.value >= 20 ? 'ниже обычного' : 'намного ниже обычного';
  const tone = score.value >= 60 ? 'result-good' : score.value >= 40 ? 'result-neutral' : 'result-bad';
  const halfLife = score.audienceHalfLife?.kind === 'observed'
    ? `Не меньше половины аудитории сохранялось <strong>${durationMonths(score.audienceHalfLife.months)}</strong> — до тома №${score.audienceHalfLife.bookNumber}`
    : score.audienceHalfLife?.kind === 'estimated'
      ? `По текущей динамике половина аудитории сохраняется около <strong>${durationMonths(score.audienceHalfLife.months)}</strong>`
      : score.audienceHalfLife?.kind === 'growth'
        ? 'Аудитория к последнему учтённому тому <strong>выросла</strong>'
        : 'Срок сохранения половины аудитории <strong>пока не определить</strong>';
  return `<div class="score-context ${tone}"><span><strong>Среди похожих циклов:</strong> ${comparison}</span><span>${halfLife}</span></div>`;
}

function diagnosticReport(cycle, score) {
  return [
    `AT Cycle Catalog ${chrome.runtime.getManifest().version} · модель ${cycle.metricVersion || '—'}`,
    `${cycle.title} — ${cycle.author || 'Автор не указан'}`,
    cycle.url,
    `Режим: база том №${score.baselineBook || '—'}, последний том №${score.lastBook || '—'}, в расчёте ${score.includedCount || 0}`,
    `Балл: ${score.value ?? 'не рассчитан'}; аудитория ${percent(score.audienceRetention)} (эталон ${percent(score.expectedAudienceRetention)}, ${score.audiencePoints || 0}/60); лайки ${percent(score.likeRetention)} (эталон ${percent(score.expectedLikeRetention)}, ${score.likePoints || 0}/40)`,
    `Лайков на 100 добавлений: ${decimal(score.baselineLikesPer100Libraries)} → ${decimal(score.lastLikesPer100Libraries)} (справочно)`,
    `Срок расчёта: ${score.ratingDurationLabel || '—'}; медианный интервал: ${durationMonths(score.medianPublicationGapMonths)}; потеря 50%: ${durationMonths(score.audienceHalfLife?.months)}`,
    `Участвуют тома: ${(score.includedBookNumbers || []).join(', ') || '—'}; исключены по датам: ${(score.excludedChronologyBooks || []).join(', ') || 'нет'}; исключены по объёму: ${(score.excludedVolumeBooks || []).join(', ') || 'нет'}`
  ].join('\n');
}

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
    panel.innerHTML = renderDynamics(response.cycle, selectedScore(response.cycle));
    button.textContent = 'Скрыть динамику';
  } catch (error) {
    panel.innerHTML = `<div class="chart-loading chart-error">Не удалось загрузить динамику: ${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

function renderDynamics(cycle, score) {
  const books = cycle.books || [];
  const baselineIndex = Math.max(0, Number(score.baselineBook || 1) - 1);
  const lastIndex = Math.max(baselineIndex, Number(score.lastBook || books.length) - 1);
  const excluded = new Set([...(score.excludedChronologyBooks || []), ...(score.excludedVolumeBooks || [])].map(Number));
  const active = books.map((book, index) => index >= baselineIndex && index <= lastIndex
    && !excluded.has(index + 1) && (!score.finishedOnly || book.isFinished !== false));
  const allBooks = books.map(() => true);
  const baseLibraries = Number(books[baselineIndex]?.libraries);
  const baseLikes = Number(books[baselineIndex]?.likes);
  const retention = [
    { label: 'Аудитория', color: '#63c987', className: 'legend-library', values: books.map(book => ratioPercent(book.libraries, baseLibraries)), tooltip: (book, value) => `${count(book.libraries)} в библиотеках · ${decimal(value)}%` },
    { label: 'Лайки', color: '#bda1ff', className: 'legend-likes', values: books.map(book => ratioPercent(book.likes, baseLikes)), tooltip: (book, value) => `${count(book.likes)} лайков · ${decimal(value)}%` }
  ];
  const comments = [{ label: 'Комментарии', color: '#7fc9ff', className: 'legend-comments', values: books.map(absoluteComments), tooltip: book => `${count(book.comments)} комментариев`, finaleSpikeBook: Number(score.finaleCommentSpike?.bookNumber) || null }];
  const finaleHint = score.finaleCommentSpike ? ' Оранжевая точка — необычный объём обсуждения финала.' : '';
  return `<div class="chart-intro">Том №${score.baselineBook || 1} принят за 100%. Линия 50% показывает половину начальной аудитории. Серые точки не участвуют в рейтинге.${finaleHint}</div>${renderLineChart('Как менялись аудитория и лайки', books, retention, active, [50, 100])}<div class="discussion-chart-note">Комментарии показаны отдельно и не влияют на рейтинг: один читатель может написать несколько сообщений.</div>${renderLineChart('Комментарии по томам · справочно', books, comments, allBooks, null)}`;
}

function renderLineChart(title, books, series, active, referenceLine) {
  const width = 380, height = 180, left = 36, right = 10, top = 15, bottom = 28;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const activeValues = series.flatMap(item => item.values.filter((value, index) => active[index] && Number.isFinite(value)));
  const allValues = series.flatMap(item => item.values).filter(Number.isFinite);
  const values = activeValues.length ? activeValues : allValues;
  const referenceLines = Array.isArray(referenceLine) ? referenceLine.filter(Number.isFinite) : (Number.isFinite(referenceLine) ? [referenceLine] : []);
  const measuredValues = [...values, ...referenceLines];
  if (!measuredValues.length) measuredValues.push(0, 1);
  const measuredMin = Math.min(...measuredValues), measuredMax = Math.max(...measuredValues);
  const measuredSpan = Math.max(measuredMax - measuredMin, Math.abs(measuredMax) * .1, 1);
  const step = niceChartStep(measuredSpan / 6), padding = step / 2;
  const minY = Math.max(0, Math.floor((measuredMin - padding) / step) * step);
  const maxY = Math.max(minY + step, Math.ceil((measuredMax + padding) / step) * step);
  const x = index => left + (books.length <= 1 ? plotWidth / 2 : index * plotWidth / (books.length - 1));
  const y = value => top + plotHeight - ((Math.max(minY, Math.min(maxY, value)) - minY) / (maxY - minY)) * plotHeight;
  const gridValues = [...new Set([minY, minY + (maxY - minY) / 2, maxY, ...referenceLines.filter(value => value > minY && value < maxY)])].sort((a, b) => a - b);
  const grid = gridValues.map(value => `<g class="chart-grid"><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"></line><text x="${left - 5}" y="${y(value) + 3}">${count(Math.round(value))}</text></g>`).join('');
  const paths = series.map(item => {
    const itemActive = active;
    return `<path class="chart-line" stroke="${item.color}" d="${chartPath(item.values, itemActive, x, y)}"></path>`;
  }).join('');
  const points = series.flatMap(item => item.values.map((value, index) => {
    if (!Number.isFinite(value)) return '';
    const finaleSpike = item.finaleSpikeBook === index + 1;
    const muted = !active[index] && !finaleSpike, book = books[index], clipped = value < minY || value > maxY;
    const tip = `Том №${index + 1}: ${book.title || ''}\n${item.tooltip(book, value)}${finaleSpike ? '\nНеобычный объём обсуждения финала' : muted ? '\nНе участвует в расчёте рейтинга' : ''}${clipped ? '\nТочка прижата к краю выбранной шкалы' : ''}`;
    const pointClass = `chart-point${muted ? ' chart-point-muted' : ''}${finaleSpike ? ' chart-point-finale' : ''}`;
    return `<circle class="${pointClass}" cx="${x(index)}" cy="${y(value)}" r="${muted ? 2.5 : 3.5}" fill="${finaleSpike ? '#ff9f43' : muted ? '#716a7d' : item.color}" data-tooltip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></circle>`;
  })).join('');
  const labelStep = Math.max(1, Math.ceil(books.length / 8));
  const labels = books.map((book, index) => index % labelStep === 0 || index === books.length - 1 ? `<text class="chart-x-label" x="${x(index)}" y="${height - 8}">${index + 1}</text>` : '').join('');
  const legend = series.map(item => `<span><i class="${item.className}"></i>${item.label}</span>`).join('');
  return `<section class="chart-block"><div class="chart-heading"><strong>${title}</strong><div class="chart-legend">${legend}</div></div><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${grid}${paths}${points}${labels}</svg></section>`;
}
function niceChartStep(value) { const exponent = Math.floor(Math.log10(Math.max(value, 1e-9))), magnitude = 10 ** exponent, fraction = value / magnitude; return (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10) * magnitude; }

function chartPath(values, active, x, y) {
  let path = '', drawing = false;
  values.forEach((value, index) => {
    if (!active[index] || !Number.isFinite(value)) { drawing = false; return; }
    path += `${drawing ? ' L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
    drawing = true;
  });
  return path;
}
function ratioPercent(value, baseline) { if (value === null || value === undefined || value === '' || baseline === null || baseline === undefined || baseline === '') return null; const current = Number(value), base = Number(baseline); return Number.isFinite(current) && Number.isFinite(base) && base > 0 ? current / base * 100 : null; }
function absoluteComments(book) { if (book.comments === null || book.comments === undefined || book.comments === '') return null; const comments = Number(book.comments); return Number.isFinite(comments) ? comments : null; }
function escapeHtml(value){const el=document.createElement('div');el.textContent=value;return el.innerHTML;}
requirePrivacyConsent().then(() => render());
