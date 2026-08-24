const $ = selector => document.querySelector(selector);
setupChartTooltip();
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

async function initializeSearchPage() {
  const state = await chrome.runtime.sendMessage({ type: 'getSearchState' });
  genreRules = state.genreRules || {};
  updateGenreSummary();
  await renderExcluded(state);
}

requirePrivacyConsent().then(() => initializeSearchPage());
