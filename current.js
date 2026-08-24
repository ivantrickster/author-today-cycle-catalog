const $ = selector => document.querySelector(selector);
let currentUrl = '';
let currentCycle = null;
let inCatalog = false;

$('#catalog').onclick = () => openExtensionPage('popup.html');
$('#search').onclick = () => openExtensionPage('search.html');
$('#refresh').onclick = () => loadCycle(true);
$('#add').onclick = addToCatalog;
$('#copyReport').onclick = copyReport;
$('#fromSecond').addEventListener('input', renderCycle);
$('#finishedOnly').addEventListener('input', renderCycle);

function selectedScore() {
  const fromSecond = $('#fromSecond').checked;
  const finishedOnly = $('#finishedOnly').checked;
  const key = finishedOnly ? (fromSecond ? 'finishedFromSecond' : 'finished') : (fromSecond ? 'fromSecond' : 'default');
  return currentCycle?.scores?.[key] || currentCycle?.score || {};
}

async function activeAuthorPageUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const match = String(tab?.url || '').match(/^https:\/\/author\.today\/work\/(?:series\/\d+|\d+)(?:[/?#]|$)/i);
  return match?.[0] || '';
}

async function loadCycle(force = false) {
  setBusy(true);
  $('#notice').classList.remove('error');
  $('#notice').textContent = force ? 'Обновляю статистику открытого цикла…' : 'Проверяю открытую страницу…';
  try {
    currentUrl = await activeAuthorPageUrl();
    if (!currentUrl) {
      currentCycle = null;
      $('#notice').textContent = 'Откройте страницу тома или цикла Author.Today, затем снова нажмите значок расширения.';
      $('#controls').hidden = true;
      $('#cycle').hidden = true;
      $('#cycleActions').hidden = true;
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'analyzeCurrentCycle', url: currentUrl, force });
    if (response.status === 'paused') throw new Error(`Author.Today временно ограничил запросы до ${new Date(response.until).toLocaleString()}.`);
    if (response.status === 'standalone') {
      currentCycle = null;
      $('#notice').textContent = `Том «${response.bookTitle || 'Без названия'}» не входит в цикл.`;
      $('#controls').hidden = true;
      $('#cycle').hidden = true;
      $('#cycleActions').hidden = true;
      return;
    }
    if (response.status !== 'ready' || !response.cycle) throw new Error(response.error || 'Не удалось получить данные цикла.');
    currentCycle = response.cycle;
    inCatalog = Boolean(response.inCatalog);
    $('#notice').textContent = force ? 'Статистика обновлена.' : 'Статистика готова.';
    $('#controls').hidden = false;
    $('#cycle').hidden = false;
    $('#cycleActions').hidden = false;
    updateAddButton();
    renderCycle();
  } catch (error) {
    $('#notice').classList.add('error');
    $('#notice').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function addToCatalog() {
  if (!currentCycle || inCatalog) return;
  $('#add').disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'addSearchCycle', seriesId: currentCycle.seriesId });
  if (result.added || result.reason === 'exists') {
    inCatalog = true;
    $('#notice').textContent = result.added ? 'Цикл добавлен в мой каталог.' : 'Этот цикл уже есть в каталоге.';
  } else {
    $('#notice').classList.add('error');
    $('#notice').textContent = 'Не удалось добавить цикл. Обновите статистику и повторите.';
  }
  updateAddButton();
}

function updateAddButton() {
  $('#add').textContent = inCatalog ? 'Уже в моём каталоге' : 'Добавить в мой каталог';
  $('#add').disabled = inCatalog;
}

function renderCycle() {
  if (!currentCycle) return;
  const score = selectedScore();
  const finished = currentCycle.books.filter(book => book.isFinished !== false).length;
  const genres = (currentCycle.genres || []).slice(0, 3);
  const finale = score.finaleCommentSpike;
  const discussion = `<div class="discussion-reference"><strong>Комментарии · справочно</strong><span>Том №${score.baselineBook || 1}: ${count(score.baselineComments)} · том №${score.lastBook || '—'}: ${count(score.lastComments)}</span><small>Один читатель может написать несколько комментариев, поэтому они не влияют на рейтинг.</small></div>`;
  const notes = [];
  if (score.insufficientBooks) notes.push(`<div class="anomaly error"><strong>Недостаточно данных для рейтинга.</strong> Нужно хотя бы ${score.minimumBooksRequired || 3} подходящих тома, сейчас — ${score.includedCount || 0}.</div>`);
  if (score.recentTerminalVolume) notes.push('<div class="anomaly"><strong>Последний том вышел недавно.</strong> Его показатели ещё могут вырасти.</div>');
  if (score.modelExtrapolated) notes.push('<div class="anomaly"><strong>Цикл длиннее большинства проверенных.</strong> Поправка ограничена, чтобы не завысить рейтинг.</div>');
  if (score.modelDatesComplete === false) notes.push('<div class="anomaly"><strong>Не хватает дат публикации.</strong> Рейтинг рассчитан без поправки на время.</div>');
  if (finale) notes.push(`<div class="anomaly"><strong>Финал обсуждали особенно активно.</strong> В томе №${finale.bookNumber} намного больше комментариев, чем обычно. На рейтинг это не влияет.</div>`);
  const anomaly = notes.join('');
  const comparison = score.value >= 80 ? 'намного выше обычного' : score.value >= 60 ? 'выше обычного' : score.value >= 40 ? 'примерно как у похожих циклов' : score.value >= 20 ? 'ниже обычного' : 'намного ниже обычного';
  const tone = score.value >= 60 ? 'result-good' : score.value >= 40 ? 'result-neutral' : 'result-bad';
  const halfLife = score.audienceHalfLife?.kind === 'observed' ? `Не меньше половины аудитории сохранялось <strong>${durationMonths(score.audienceHalfLife.months)}</strong> — до тома №${score.audienceHalfLife.bookNumber}`
    : score.audienceHalfLife?.kind === 'estimated' ? `По текущей динамике половина аудитории сохраняется около <strong>${durationMonths(score.audienceHalfLife.months)}</strong>`
      : score.audienceHalfLife?.kind === 'growth' ? 'Аудитория к последнему учтённому тому <strong>выросла</strong>' : 'Срок сохранения половины аудитории <strong>пока не определить</strong>';
  const context = score.insufficientBooks ? '' : `<div class="score-context ${tone}"><span><strong>Среди похожих циклов:</strong> ${comparison}</span><span>${halfLife}</span></div>`;
  $('#cycle').innerHTML = `<article class="cycle-card">
    <div class="heading"><div><a class="title" href="${currentCycle.url}" target="_blank">${escapeHtml(currentCycle.title)}</a><div class="author">${escapeHtml(currentCycle.author || 'Автор не указан')}</div></div><strong class="score" title="Рейтинг ${score.value ?? '—'} из 100. 50 — обычный результат для цикла такой длины и продолжительности. Аудитория дала ${score.audiencePoints ?? 0} из 60 баллов, лайки — ${score.likePoints ?? 0} из 40.">${score.value ?? '—'}</strong></div>
    <div class="meta"><span class="tag">${currentCycle.status === 'completed' ? 'цикл завершён' : 'цикл в процессе'}</span> · ${currentCycle.books.length} томов · завершено ${finished}${currentCycle.durationLabel && currentCycle.durationLabel !== '—' ? ` · ${escapeHtml(currentCycle.durationLabel)}` : ''}</div>
    ${genres.length ? `<div class="genres">${genres.map(genre => `<span>${escapeHtml(genre)}</span>`).join('')}</div>` : ''}
    ${anomaly}
    <div class="metrics">
      ${metric('Аудитория к последнему учтённому тому', score.audienceRetention, `${count(score.baselineLibraries)} → ${count(score.lastLibraries)} добавлений`)}
      ${metric('Лайки к последнему учтённому тому', score.likeRetention, `${count(score.baselineLikes)} → ${count(score.lastLikes)}`)}
    </div>
    ${context}
    ${discussion}
  </article>`;
}

async function copyReport() {
  if (!currentCycle) return;
  const report = diagnosticReport(currentCycle, selectedScore());
  try { await navigator.clipboard.writeText(report); }
  catch { const area = document.createElement('textarea'); area.value = report; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
  $('#notice').textContent = 'Диагностический отчёт скопирован.';
}

function metric(label, value, detail) {
  const tone = Number.isFinite(value) && value >= .65 ? 'good' : 'bad';
  return `<div class="metric"><div class="metric-label">${label}</div><strong class="${tone}">${percent(value)}</strong><small>${detail}</small></div>`;
}

function setBusy(busy) {
  $('#refresh').disabled = busy;
  if (!inCatalog) $('#add').disabled = busy;
}

requirePrivacyConsent().then(accepted => { if (accepted) loadCycle(); });
