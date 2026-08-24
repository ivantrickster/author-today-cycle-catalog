const $ = selector => document.querySelector(selector);
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
let nextCursor = { page: 1, offset: 0 };
let activeFilters = null;
let accumulatedResults = [];
let totalChecked = 0;
let searchBusy = false;
let genreCatalog = [];
let genreRules = {};
let draftGenreRules = {};
const expandedGenreGroups = new Set();

$('#searchForm').addEventListener('submit', event => {
  event.preventDefault();
  startSearch();
});
$('#loadMore').addEventListener('click', () => runSearch(nextCursor, false));
$('#genreButton').addEventListener('click', openGenreModal);
$('#closeGenres').addEventListener('click', closeGenreModal);
$('#cancelGenres').addEventListener('click', closeGenreModal);
$('#applyGenres').addEventListener('click', applyGenreRules);
$('#clearGenres').addEventListener('click', () => {
  draftGenreRules = {};
  renderGenreDialog();
});
$('#genreSearch').addEventListener('input', renderGenreTree);
document.querySelector('[data-close-genres]').addEventListener('click', closeGenreModal);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#genreModal').hidden) closeGenreModal();
});

function readFilters() {
  return {
    status: $('#status').value,
    sorting: 'views',
    minScore: $('#minScore').value,
    minAudienceRetention: $('#minAudienceRetention').value,
    minLikeRetention: $('#minLikeRetention').value,
    minBookLikes: $('#minBookLikes').value,
    genreRules: { ...genreRules },
    minBooks: $('#minBooks').value,
    fromSecond: $('#fromSecond').checked,
    finishedOnly: $('#finishedOnly').checked
  };
}

async function startSearch() {
  activeFilters = readFilters();
  nextCursor = { page: 1, offset: 0 };
  totalChecked = 0;
  accumulatedResults = [];
  renderResults();
  await runSearch(nextCursor, true);
}

async function runSearch(cursor, reset) {
  if (searchBusy) return;
  searchBusy = true;
  setBusy(true);
  $('#notice').textContent = reset ? 'Подбираю 10 подходящих циклов…' : 'Подбираю ещё 10 подходящих циклов…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'searchCycles', filters: activeFilters || readFilters(), cursor });
    if (response.status === 'error') throw new Error(response.error || 'Неизвестная ошибка');
    if (!response.cursor) throw new Error('Фоновая часть расширения устарела. Перезагрузите «Каталог циклов» на странице управления расширениями и повторите поиск.');
    nextCursor = response.cursor || nextCursor;
    totalChecked += response.checked || 0;
    const known = new Set(accumulatedResults.map(cycle => Number(cycle.seriesId)));
    for (const cycle of response.results || []) if (!known.has(Number(cycle.seriesId))) accumulatedResults.push(cycle);
    sortResults();
    renderResults();
    $('#loadMore').hidden = response.isLastPage || response.status === 'paused' || (response.results || []).length < 10;
    if (response.status === 'paused') {
      $('#notice').textContent = `Author.Today временно ограничил запросы. Поиск приостановлен до ${new Date(response.until).toLocaleString()}.`;
    } else {
      const skipped = response.skipped ? ` Не удалось разобрать: ${response.skipped}.` : '';
      const exhausted = response.isLastPage ? ' Каталог по этим условиям закончился.' : '';
      $('#notice').textContent = `Показано: ${accumulatedResults.length}. Для подбора проверено: ${totalChecked}.${skipped}${exhausted}`;
    }
  } catch (error) {
    $('#notice').textContent = `Не удалось выполнить поиск: ${error.message}`;
  } finally {
    searchBusy = false;
    setBusy(false);
  }
}

function selectedScore(cycle) {
  const filters = activeFilters || readFilters();
  const key = filters.finishedOnly ? (filters.fromSecond ? 'finishedFromSecond' : 'finished') : (filters.fromSecond ? 'fromSecond' : 'default');
  return cycle.scores?.[key] || cycle.score || {};
}

function sortResults() {
  accumulatedResults.sort((a, b) => (selectedScore(b).value ?? -1) - (selectedScore(a).value ?? -1));
}

async function openGenreModal() {
  draftGenreRules = { ...genreRules };
  $('#genreModal').hidden = false;
  document.body.classList.add('modal-open');
  $('#genreNotice').textContent = genreCatalog.length ? '' : 'Загружаю список жанров…';
  $('#genreSearch').value = '';
  if (!genreCatalog.length) {
    const response = await chrome.runtime.sendMessage({ type: 'getGenres' });
    genreCatalog = response.genres || [];
    $('#genreNotice').textContent = response.error ? `Не удалось загрузить жанры: ${response.error}` : '';
  }
  materializeGroupRules();
  const genreById = new Map(genreCatalog.map(genre => [Number(genre.id), genre]));
  for (const id of Object.keys(draftGenreRules).map(Number)) {
    let parentId = Number(genreById.get(id)?.parentId) || 0;
    while (parentId) {
      expandedGenreGroups.add(parentId);
      parentId = Number(genreById.get(parentId)?.parentId) || 0;
    }
  }
  renderGenreDialog();
  $('#genreSearch').focus();
}

function closeGenreModal() {
  $('#genreModal').hidden = true;
  document.body.classList.remove('modal-open');
}

async function applyGenreRules() {
  const result = await chrome.runtime.sendMessage({ type: 'saveGenreRules', rules: draftGenreRules });
  genreRules = result.genreRules || {};
  updateGenreSummary();
  closeGenreModal();
}

function renderGenreDialog() {
  renderGenreSelections();
  renderGenreTree();
}

function renderGenreSelections() {
  const genreById = new Map(genreCatalog.map(genre => [Number(genre.id), genre]));
  const entries = compactGenreRuleEntries(draftGenreRules, genreById);
  $('#genreSelections').innerHTML = entries.length ? entries.map(([id, state]) => {
    const title = genreById.get(Number(id))?.title || `Жанр ${id}`;
    const label = state === 'include' ? 'Учитывать' : 'Исключить';
    return `<span class="genre-chip ${state}">${label}: ${escapeHtml(title)}<button type="button" data-remove-genre="${id}" aria-label="Убрать правило">×</button></span>`;
  }).join('') : '';
  document.querySelectorAll('[data-remove-genre]').forEach(button => button.onclick = () => {
    clearGenreRule(Number(button.dataset.removeGenre));
    renderGenreDialog();
  });
}

function renderGenreTree() {
  if (!genreCatalog.length) {
    $('#genreTree').innerHTML = '<div class="genre-empty">Список жанров недоступен.</div>';
    return;
  }
  const query = $('#genreSearch').value.trim().toLocaleLowerCase('ru-RU');
  const genreById = new Map(genreCatalog.map(genre => [Number(genre.id), genre]));
  const childrenByParent = new Map();
  for (const genre of genreCatalog) {
    if (genre.parentId === null) continue;
    const children = childrenByParent.get(Number(genre.parentId)) || [];
    children.push(genre);
    childrenByParent.set(Number(genre.parentId), children);
  }
  const roots = genreCatalog.filter(genre => genre.parentId === null);
  const groups = roots.map(root => {
    const children = childrenByParent.get(Number(root.id)) || [];
    const rootMatches = !query || root.title.toLocaleLowerCase('ru-RU').includes(query);
    const visibleChildren = query && !rootMatches ? children.filter(child => child.title.toLocaleLowerCase('ru-RU').includes(query)) : children;
    if (!rootMatches && !visibleChildren.length) return '';
    if (!children.length) return genreRow(root, genreById, false, false, [Number(root.id)]);
    const expanded = query ? true : expandedGenreGroups.has(Number(root.id));
    const subtreeIds = genreSubtreeIds(Number(root.id));
    return `<section class="genre-group" data-genre-group="${root.id}">
      ${genreRow(root, genreById, true, expanded, subtreeIds)}
      <div class="genre-children"${expanded ? '' : ' hidden'}>${visibleChildren.map(child => genreRow(child, genreById, false, false, [Number(child.id)])).join('')}</div>
    </section>`;
  }).join('');
  $('#genreTree').innerHTML = groups || '<div class="genre-empty">Жанры не найдены.</div>';
  document.querySelectorAll('[data-toggle-genre]').forEach(button => button.onclick = () => {
    const id = Number(button.dataset.toggleGenre);
    if (expandedGenreGroups.has(id)) expandedGenreGroups.delete(id); else expandedGenreGroups.add(id);
    renderGenreTree();
  });
  document.querySelectorAll('.genre-checkbox[data-indeterminate="true"]').forEach(checkbox => { checkbox.indeterminate = true; });
  document.querySelectorAll('.genre-checkbox').forEach(checkbox => checkbox.onchange = () => {
    const id = Number(checkbox.dataset.genreId);
    const state = checkbox.dataset.rule;
    const ids = checkbox.dataset.group === 'true' ? genreSubtreeIds(id) : [id];
    const allSelected = ids.every(itemId => draftGenreRules[String(itemId)] === state);
    if (allSelected) {
      for (const itemId of ids) clearGenreState(itemId, state);
    } else {
      for (const itemId of ids) draftGenreRules[String(itemId)] = state;
    }
    renderGenreDialog();
  });
}

function genreRow(genre, genreById, hasChildren, expanded = false, affectedIds = [Number(genre.id)]) {
  const id = String(Number(genre.id));
  const includeCount = affectedIds.filter(itemId => draftGenreRules[String(itemId)] === 'include').length;
  const excludeCount = affectedIds.filter(itemId => draftGenreRules[String(itemId)] === 'exclude').length;
  const allInclude = includeCount === affectedIds.length;
  const allExclude = excludeCount === affectedIds.length;
  const someInclude = includeCount > 0 && !allInclude;
  const someExclude = excludeCount > 0 && !allExclude;
  return `<div class="genre-leaf">
    <div class="genre-row">
      <div class="genre-title-wrap">
        ${hasChildren ? `<button class="genre-toggle" type="button" data-toggle-genre="${id}" aria-label="${expanded ? 'Свернуть' : 'Развернуть'}">${expanded ? '▾' : '▸'}</button>` : '<span class="genre-toggle"></span>'}
        <span class="genre-title">${escapeHtml(genre.title)}</span>
        <span class="genre-count">${count(genre.workCount)}</span>
      </div>
      <div class="genre-rule-pair">
        <label class="genre-check include"><input class="genre-checkbox" type="checkbox" data-genre-id="${id}" data-rule="include" data-group="${hasChildren}"${allInclude ? ' checked' : ''}${someInclude ? ' data-indeterminate="true"' : ''}> <span>Учитывать</span></label>
        <label class="genre-check exclude"><input class="genre-checkbox" type="checkbox" data-genre-id="${id}" data-rule="exclude" data-group="${hasChildren}"${allExclude ? ' checked' : ''}${someExclude ? ' data-indeterminate="true"' : ''}> <span>Исключить</span></label>
      </div>
    </div>
  </div>`;
}

function ancestorGenreRule(genre, rules, genreById) {
  let parentId = Number(genre.parentId) || 0;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const state = rules[String(parentId)];
    if (state) return state === 'neutral' ? null : state;
    parentId = Number(genreById.get(parentId)?.parentId) || 0;
  }
  return null;
}

function genreSubtreeIds(rootId) {
  const ids = [];
  const pending = [Number(rootId)];
  while (pending.length) {
    const id = pending.shift();
    ids.push(id);
    for (const genre of genreCatalog) if (Number(genre.parentId) === id) pending.push(Number(genre.id));
  }
  return ids;
}

function materializeGroupRules() {
  for (const genre of genreCatalog) {
    const state = draftGenreRules[String(genre.id)];
    if (!['include', 'exclude'].includes(state)) continue;
    const descendants = genreSubtreeIds(Number(genre.id)).slice(1);
    for (const id of descendants) if (!(String(id) in draftGenreRules)) draftGenreRules[String(id)] = state;
  }
}

function clearGenreState(id, state) {
  const key = String(Number(id));
  if (draftGenreRules[key] !== state) return;
  delete draftGenreRules[key];
  const genreById = new Map(genreCatalog.map(genre => [Number(genre.id), genre]));
  const genre = genreById.get(Number(id));
  if (genre && ancestorGenreRule(genre, draftGenreRules, genreById)) draftGenreRules[key] = 'neutral';
}

function clearGenreRule(id) {
  const subtree = genreSubtreeIds(id);
  if (subtree.length > 1) {
    for (const itemId of subtree) delete draftGenreRules[String(itemId)];
  } else {
    const state = draftGenreRules[String(id)];
    if (['include', 'exclude'].includes(state)) clearGenreState(id, state); else delete draftGenreRules[String(id)];
  }
}

function compactGenreRuleEntries(rules, genreById) {
  return Object.entries(rules).filter(([id, state]) => {
    if (!['include', 'exclude'].includes(state)) return false;
    const genre = genreById.get(Number(id));
    return !genre || ancestorGenreRule(genre, rules, genreById) !== state;
  });
}

function updateGenreSummary() {
  const genreById = new Map(genreCatalog.map(genre => [Number(genre.id), genre]));
  const compactRules = genreCatalog.length ? compactGenreRuleEntries(genreRules, genreById) : Object.entries(genreRules).filter(([, state]) => ['include', 'exclude'].includes(state));
  const includeCount = compactRules.filter(([, state]) => state === 'include').length;
  const excludeCount = compactRules.filter(([, state]) => state === 'exclude').length;
  if (!includeCount && !excludeCount) $('#genreSummary').textContent = 'Любые жанры';
  else if (includeCount && excludeCount) $('#genreSummary').textContent = `Учитывать: ${includeCount} · исключить: ${excludeCount}`;
  else if (includeCount) $('#genreSummary').textContent = `Учитывать выбранные: ${includeCount}`;
  else $('#genreSummary').textContent = `Исключить выбранные: ${excludeCount}`;
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
  return [`AT Cycle Catalog ${chrome.runtime.getManifest().version} · модель ${cycle.metricVersion || '—'}`, `${cycle.title} — ${cycle.author || 'Автор не указан'}`, cycle.url,
    `Режим: база том №${score.baselineBook || '—'}, последний том №${score.lastBook || '—'}, в расчёте ${score.includedCount || 0}`,
    `Балл: ${score.value ?? 'не рассчитан'}; аудитория ${percent(score.audienceRetention)} (эталон ${percent(score.expectedAudienceRetention)}, ${score.audiencePoints || 0}/60); лайки ${percent(score.likeRetention)} (эталон ${percent(score.expectedLikeRetention)}, ${score.likePoints || 0}/40)`,
    `Лайков на 100 добавлений: ${decimal(score.baselineLikesPer100Libraries)} → ${decimal(score.lastLikesPer100Libraries)} (справочно)`,
    `Срок расчёта: ${score.ratingDurationLabel || '—'}; медианный интервал: ${durationMonths(score.medianPublicationGapMonths)}; потеря 50%: ${durationMonths(score.audienceHalfLife?.months)}`,
    `Участвуют тома: ${(score.includedBookNumbers || []).join(', ') || '—'}; исключены по датам: ${(score.excludedChronologyBooks || []).join(', ') || 'нет'}; исключены по объёму: ${(score.excludedVolumeBooks || []).join(', ') || 'нет'}`].join('\n');
}

async function copyReport(cycle, score) {
  const text = diagnosticReport(cycle, score);
  try { await navigator.clipboard.writeText(text); }
  catch { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
  $('#progress').textContent = 'Диагностический отчёт скопирован.';
}

function renderResults() {
  $('#summary').textContent = accumulatedResults.length ? `Найдено подходящих циклов: ${accumulatedResults.length}` : 'Подходящих циклов пока нет.';
  $('#results').innerHTML = accumulatedResults.length ? accumulatedResults.map(cycle => {
    const score = selectedScore(cycle);
    const finished = cycle.books.filter(book => book.isFinished !== false).length;
    const anomalyNote = scoreNotes(score);
    const genres = (cycle.genres || []).slice(0, 3);
    const genreLine = genres.length ? `<div class="genre-tags" aria-label="Жанры первого тома">${genres.map(genre => `<span>${escapeHtml(genre)}</span>`).join('')}</div>` : '';
    const discussionReference = `<div class="discussion-reference"><strong>Комментарии · справочно</strong><span>Том №${score.baselineBook || 1}: ${count(score.baselineComments)} · том №${score.lastBook || '—'}: ${count(score.lastComments)}</span><small>Один читатель может написать несколько комментариев, поэтому они не влияют на рейтинг.</small></div>`;
    return `<article class="card" data-series-id="${cycle.seriesId}">
      <div class="card-head">
        <div><a class="cycle-title" href="${cycle.url}" target="_blank">${escapeHtml(cycle.title)}</a><div class="author">${escapeHtml(cycle.author)}</div></div>
        <strong class="score" title="${ratingHint(score)}">${score.value ?? '—'}</strong>
      </div>
      <div class="meta"><span class="tag">${cycle.status === 'completed' ? 'цикл завершён' : 'цикл в процессе'}</span> ${cycle.books.length} томов · завершено ${finished}${cycle.durationLabel && cycle.durationLabel !== '—' ? ` · ${cycle.durationLabel}` : ''}</div>
      ${genreLine}
      ${anomalyNote}
      <div class="metrics">
        <div class="metric">Аудитория к последнему учтённому тому<b class="${(score.audienceRetention ?? 0) >= .65 ? 'good' : 'bad'}">${percent(score.audienceRetention)}</b><span class="counts">${count(score.baselineLibraries)} → ${count(score.lastLibraries)} добавлений</span></div>
        <div class="metric">Лайки к последнему учтённому тому<b class="${(score.likeRetention ?? 0) >= .65 ? 'good' : 'bad'}">${percent(score.likeRetention)}</b><span class="counts">${count(score.baselineLikes)} → ${count(score.lastLikes)}</span></div>
      </div>
      ${scoreContext(score)}
      ${discussionReference}
      <div class="actions">
        <button class="secondary show-dynamics" data-id="${cycle.seriesId}" type="button">Показать динамику</button>
        <button class="secondary copy-report" data-id="${cycle.seriesId}" type="button">Скопировать отчёт</button>
        <button class="primary add-cycle" data-id="${cycle.seriesId}">Добавить в мой каталог</button>
        <button class="danger-soft exclude-cycle" data-id="${cycle.seriesId}" data-reason="ignored">Не интересует</button>
        <button class="read exclude-cycle" data-id="${cycle.seriesId}" data-reason="read">Уже прочитано</button>
      </div>
      <div class="dynamics" data-dynamics-id="${cycle.seriesId}" hidden></div>
    </article>`;
  }).join('') : '<div class="empty">Запустите поиск или смягчите фильтры.</div>';
  document.querySelectorAll('.add-cycle').forEach(button => button.onclick = () => addCycle(Number(button.dataset.id), button));
  document.querySelectorAll('.exclude-cycle').forEach(button => button.onclick = () => hideCycle(Number(button.dataset.id), button.dataset.reason));
  document.querySelectorAll('.show-dynamics').forEach(button => button.onclick = () => toggleDynamics(Number(button.dataset.id), button));
  document.querySelectorAll('.copy-report').forEach(button => button.onclick = () => {
    const cycle = accumulatedResults.find(item => Number(item.seriesId) === Number(button.dataset.id));
    if (cycle) copyReport(cycle, selectedScore(cycle));
  });
}

async function toggleDynamics(seriesId, button) {
  const panel = document.querySelector(`[data-dynamics-id="${seriesId}"]`);
  if (!panel) return;
  if (!panel.hidden) {
    panel.hidden = true;
    button.textContent = 'Показать динамику';
    return;
  }
  panel.hidden = false;
  panel.innerHTML = '<div class="chart-loading">Загружаю статистику по всем томам…</div>';
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getCycleDynamics', seriesId });
    if (response.status !== 'ready' || !response.cycle) throw new Error(response.error || 'данные цикла не найдены');
    const index = accumulatedResults.findIndex(item => Number(item.seriesId) === seriesId);
    if (index >= 0) accumulatedResults[index] = response.cycle;
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
  const retentionSeries = [
    {
      label: 'Аудитория', color: '#63c987', className: 'legend-library',
      values: books.map(book => ratioPercent(book.libraries, baseLibraries)),
      tooltip: (book, value) => `${count(book.libraries)} в библиотеках · ${decimal(value)}% от базы`
    },
    {
      label: 'Лайки', color: '#bda1ff', className: 'legend-likes',
      values: books.map(book => ratioPercent(book.likes, baseLikes)),
      tooltip: (book, value) => `${count(book.likes)} лайков · ${decimal(value)}% от базы`
    }
  ];
  const commentSeries = [{
    label: 'Комментарии', color: '#7fc9ff', className: 'legend-comments',
    values: books.map(book => absoluteComments(book)),
    tooltip: book => `${count(book.comments)} комментариев`,
    finaleSpikeBook: Number(score.finaleCommentSpike?.bookNumber) || null
  }];
  const finaleHint = score.finaleCommentSpike ? ' Оранжевая точка — необычный объём обсуждения финала.' : '';
  return `<div class="chart-intro">Том №${score.baselineBook || 1} принят за 100%. Линия 50% показывает половину начальной аудитории. Серые точки не участвуют в рейтинге.${finaleHint} Наведите на точку для точных значений.</div>
    ${renderLineChart('Как менялись аудитория и лайки', books, retentionSeries, active, [50, 100])}
    <div class="discussion-chart-note">Комментарии показаны отдельно и не влияют на рейтинг: один читатель может написать несколько сообщений.</div>
    ${renderLineChart('Комментарии по томам · справочно', books, commentSeries, allBooks, null)}`;
}

function renderLineChart(title, books, series, active, referenceLine) {
  const width = 760, height = 220, left = 48, right = 16, top = 18, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const activeValues = series.flatMap(item => item.values.filter((value, index) => active[index] && Number.isFinite(value)));
  const allValues = series.flatMap(item => item.values).filter(Number.isFinite);
  const finiteValues = activeValues.length ? activeValues : allValues;
  const referenceLines = Array.isArray(referenceLine) ? referenceLine.filter(Number.isFinite) : (Number.isFinite(referenceLine) ? [referenceLine] : []);
  const measuredValues = [...finiteValues, ...referenceLines];
  if (!measuredValues.length) measuredValues.push(0, 1);
  const measuredMin = Math.min(...measuredValues);
  const measuredMax = Math.max(...measuredValues);
  const measuredSpan = Math.max(measuredMax - measuredMin, Math.abs(measuredMax) * .1, 1);
  const step = niceChartStep(measuredSpan / 6);
  const padding = step / 2;
  const minY = Math.max(0, Math.floor((measuredMin - padding) / step) * step);
  const maxY = Math.max(minY + step, Math.ceil((measuredMax + padding) / step) * step);
  const x = index => left + (books.length <= 1 ? plotWidth / 2 : index * plotWidth / (books.length - 1));
  const y = value => top + plotHeight - ((Math.max(minY, Math.min(maxY, value)) - minY) / (maxY - minY)) * plotHeight;
  const gridValues = [...new Set([minY, minY + (maxY - minY) / 2, maxY, ...referenceLines.filter(value => value > minY && value < maxY)])].sort((a, b) => a - b);
  const grid = gridValues.map(value => `<g class="chart-grid"><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"></line><text x="${left - 7}" y="${y(value) + 4}">${count(Math.round(value))}</text></g>`).join('');
  const paths = series.map(item => {
    const itemActive = active;
    return `<path class="chart-line" stroke="${item.color}" d="${chartPath(item.values, itemActive, x, y)}"></path>`;
  }).join('');
  const points = series.flatMap(item => item.values.map((value, index) => {
    if (!Number.isFinite(value)) return '';
    const finaleSpike = item.finaleSpikeBook === index + 1;
    const muted = !active[index] && !finaleSpike;
    const book = books[index];
    const clipped = value < minY || value > maxY;
    const tooltip = `Том №${index + 1}: ${book.title || ''}\n${item.tooltip(book, value)}${finaleSpike ? '\nНеобычный объём обсуждения финала' : muted ? '\nНе участвует в расчёте рейтинга' : ''}${clipped ? '\nТочка прижата к краю выбранной шкалы' : ''}`;
    const pointClass = `chart-point${muted ? ' chart-point-muted' : ''}${finaleSpike ? ' chart-point-finale' : ''}`;
    return `<circle class="${pointClass}" cx="${x(index)}" cy="${y(value)}" r="${muted ? 3 : 4}" fill="${finaleSpike ? '#ff9f43' : muted ? '#716a7d' : item.color}" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}"></circle>`;
  })).join('');
  const labelStep = Math.max(1, Math.ceil(books.length / 10));
  const xLabels = books.map((book, index) => (index % labelStep === 0 || index === books.length - 1)
    ? `<text class="chart-x-label" x="${x(index)}" y="${height - 10}">${index + 1}</text>` : '').join('');
  const legend = series.map(item => `<span><i class="${item.className}"></i>${item.label}</span>`).join('');
  return `<section class="chart-block"><div class="chart-heading"><strong>${title}</strong><div class="chart-legend">${legend}</div></div><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${grid}${paths}${points}${xLabels}</svg></section>`;
}

function niceChartStep(value) {
  const exponent = Math.floor(Math.log10(Math.max(value, 1e-9)));
  const magnitude = 10 ** exponent;
  const fraction = value / magnitude;
  const niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  return niceFraction * magnitude;
}

function chartPath(values, active, x, y) {
  let path = '', drawing = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!active[index] || !Number.isFinite(value)) { drawing = false; continue; }
    path += `${drawing ? ' L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
    drawing = true;
  }
  return path;
}

function ratioPercent(value, baseline) {
  if (value === null || value === undefined || value === '' || baseline === null || baseline === undefined || baseline === '') return null;
  const current = Number(value), base = Number(baseline);
  return Number.isFinite(current) && Number.isFinite(base) && base > 0 ? current / base * 100 : null;
}

function absoluteComments(book) {
  if (book.comments === null || book.comments === undefined || book.comments === '') return null;
  const comments = Number(book.comments);
  return Number.isFinite(comments) ? comments : null;
}

async function addCycle(seriesId, button) {
  button.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'addSearchCycle', seriesId });
  button.textContent = result.added ? 'Добавлено' : result.reason === 'exists' ? 'Уже в каталоге' : 'Не удалось добавить';
}

async function hideCycle(seriesId, reason) {
  const cycle = accumulatedResults.find(item => Number(item.seriesId) === seriesId);
  if (!cycle) return;
  await chrome.runtime.sendMessage({ type: 'excludeCycle', cycle: { seriesId, title: cycle.title, author: cycle.author }, reason });
  accumulatedResults = accumulatedResults.filter(item => Number(item.seriesId) !== seriesId);
  renderResults();
  await renderExcluded();
}

async function renderExcluded(providedState = null) {
  const state = providedState || await chrome.runtime.sendMessage({ type: 'getSearchState' });
  const items = state.excludedCycles || [];
  $('#excludedCount').textContent = items.length;
  $('#excludedList').innerHTML = items.length ? items.map(item => `<div class="excluded-item">
    <div><div class="excluded-title">${escapeHtml(item.title)}</div><div class="excluded-reason">${escapeHtml(item.author)} · ${item.reason === 'read' ? 'уже прочитано' : 'не интересует'}</div></div>
    <button class="secondary restore" data-id="${item.seriesId}">Вернуть в поиск</button>
  </div>`).join('') : '<p class="muted">Исключённых циклов пока нет.</p>';
  document.querySelectorAll('.restore').forEach(button => button.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'restoreExcluded', seriesId: Number(button.dataset.id) });
    renderExcluded();
  });
}

function setBusy(busy) {
  $('#searchButton').disabled = busy;
  $('#loadMore').disabled = busy;
}
function percent(value) { return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'; }
function count(value) { return Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—'; }
function decimal(value) { return Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—'; }
function plural(value, forms) { const tens = value % 100, units = value % 10; return tens >= 11 && tens <= 14 ? forms[2] : units === 1 ? forms[0] : units >= 2 && units <= 4 ? forms[1] : forms[2]; }
function durationMonths(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1) return 'менее месяца';
  const months = Math.max(1, Math.round(value)), years = Math.floor(months / 12), remainder = months % 12;
  const parts = [];
  if (years) parts.push(`${years} ${plural(years, ['год', 'года', 'лет'])}`);
  if (remainder) parts.push(`${remainder} ${plural(remainder, ['месяц', 'месяца', 'месяцев'])}`);
  return parts.join(' ');
}
function escapeHtml(value) { const element = document.createElement('div'); element.textContent = value || ''; return element.innerHTML; }

async function initializeSearchPage() {
  const state = await chrome.runtime.sendMessage({ type: 'getSearchState' });
  genreRules = state.genreRules || {};
  updateGenreSummary();
  await renderExcluded(state);
}

requirePrivacyConsent().then(() => initializeSearchPage());
