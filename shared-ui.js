function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function count(value) {
  return Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—';
}

function decimal(value) {
  return Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—';
}

function plural(value, forms) {
  const tens = value % 100;
  const units = value % 10;
  return tens >= 11 && tens <= 14 ? forms[2] : units === 1 ? forms[0] : units >= 2 && units <= 4 ? forms[1] : forms[2];
}

function durationMonths(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1) return 'менее месяца';
  const months = Math.max(1, Math.round(value));
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  const parts = [];
  if (years) parts.push(`${years} ${plural(years, ['год', 'года', 'лет'])}`);
  if (remainder) parts.push(`${remainder} ${plural(remainder, ['месяц', 'месяца', 'месяцев'])}`);
  return parts.join(' ');
}

function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = value ?? '';
  return element.innerHTML;
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

function setupChartTooltip() {
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  document.body.append(tooltip);

  const position = (clientX, clientY) => {
    const gap = 12;
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(clientX + gap, window.innerWidth - bounds.width - 8))}px`;
    const below = clientY + gap;
    tooltip.style.top = `${below + bounds.height <= window.innerHeight - 8 ? below : Math.max(8, clientY - bounds.height - gap)}px`;
  };

  document.addEventListener('pointerover', event => {
    const point = event.target.closest?.('.chart-point[data-tooltip]');
    if (!point) return;
    tooltip.textContent = point.dataset.tooltip;
    tooltip.hidden = false;
    position(event.clientX, event.clientY);
  });
  document.addEventListener('pointermove', event => {
    if (!tooltip.hidden && event.target.closest?.('.chart-point[data-tooltip]')) position(event.clientX, event.clientY);
  });
  document.addEventListener('pointerout', event => {
    if (event.target.closest?.('.chart-point[data-tooltip]')) tooltip.hidden = true;
  });
}

function renderDynamics(cycle, score, { compact = false } = {}) {
  const books = cycle.books || [];
  const baselineIndex = Math.max(0, Number(score.baselineBook || 1) - 1);
  const lastIndex = Math.max(baselineIndex, Number(score.lastBook || books.length) - 1);
  const excluded = new Set([...(score.excludedChronologyBooks || []), ...(score.excludedVolumeBooks || [])].map(Number));
  const active = books.map((book, index) => index >= baselineIndex && index <= lastIndex
    && !excluded.has(index + 1) && (!score.finishedOnly || book.isFinished !== false));
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
    values: books.map(absoluteComments),
    tooltip: book => `${count(book.comments)} комментариев`,
    finaleSpikeBook: Number(score.finaleCommentSpike?.bookNumber) || null
  }];
  const finaleHint = score.finaleCommentSpike ? ' Оранжевая точка — необычный объём обсуждения финала.' : '';
  return `<div class="chart-intro">Том №${score.baselineBook || 1} принят за 100%. Линия 50% показывает половину начальной аудитории. Серые точки не участвуют в рейтинге.${finaleHint} Наведите на точку для точных значений.</div>
    ${renderLineChart('Как менялись аудитория и лайки', books, retentionSeries, active, [50, 100], compact)}
    <div class="discussion-chart-note">Комментарии показаны отдельно и не влияют на рейтинг: один читатель может написать несколько сообщений.</div>
    ${renderLineChart('Комментарии по томам · справочно', books, commentSeries, books.map(() => true), null, compact)}`;
}

function renderLineChart(title, books, series, active, referenceLine, compact = false) {
  const width = compact ? 380 : 760;
  const height = compact ? 180 : 220;
  const left = compact ? 36 : 48;
  const right = compact ? 10 : 16;
  const top = compact ? 15 : 18;
  const bottom = compact ? 28 : 34;
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
  const grid = gridValues.map(value => `<g class="chart-grid"><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"></line><text x="${left - (compact ? 5 : 7)}" y="${y(value) + (compact ? 3 : 4)}">${count(Math.round(value))}</text></g>`).join('');
  const paths = series.map(item => `<path class="chart-line" stroke="${item.color}" d="${chartPath(item.values, active, x, y)}"></path>`).join('');
  const points = series.flatMap(item => item.values.map((value, index) => {
    if (!Number.isFinite(value)) return '';
    const finaleSpike = item.finaleSpikeBook === index + 1;
    const muted = !active[index] && !finaleSpike;
    const book = books[index];
    const clipped = value < minY || value > maxY;
    const tooltip = `Том №${index + 1}: ${book.title || ''}\n${item.tooltip(book, value)}${finaleSpike ? '\nНеобычный объём обсуждения финала' : muted ? '\nНе участвует в расчёте рейтинга' : ''}${clipped ? '\nТочка прижата к краю выбранной шкалы' : ''}`;
    const pointClass = `chart-point${muted ? ' chart-point-muted' : ''}${finaleSpike ? ' chart-point-finale' : ''}`;
    const radius = compact ? (muted ? 2.5 : 3.5) : (muted ? 3 : 4);
    return `<circle class="${pointClass}" cx="${x(index)}" cy="${y(value)}" r="${radius}" fill="${finaleSpike ? '#ff9f43' : muted ? '#716a7d' : item.color}" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}"></circle>`;
  })).join('');
  const labelStep = Math.max(1, Math.ceil(books.length / (compact ? 8 : 10)));
  const xLabels = books.map((book, index) => (index % labelStep === 0 || index === books.length - 1)
    ? `<text class="chart-x-label" x="${x(index)}" y="${height - (compact ? 8 : 10)}">${index + 1}</text>` : '').join('');
  const legend = series.map(item => `<span><i class="${item.className}"></i>${item.label}</span>`).join('');
  return `<section class="chart-block"><div class="chart-heading"><strong>${title}</strong><div class="chart-legend">${legend}</div></div><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${grid}${paths}${points}${xLabels}</svg></section>`;
}

function niceChartStep(value) {
  const exponent = Math.floor(Math.log10(Math.max(value, 1e-9)));
  const magnitude = 10 ** exponent;
  const fraction = value / magnitude;
  return (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10) * magnitude;
}

function chartPath(values, active, x, y) {
  let path = '';
  let drawing = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!active[index] || !Number.isFinite(value)) {
      drawing = false;
      continue;
    }
    path += `${drawing ? ' L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
    drawing = true;
  }
  return path;
}

function ratioPercent(value, baseline) {
  if (value === null || value === undefined || value === '' || baseline === null || baseline === undefined || baseline === '') return null;
  const current = Number(value);
  const base = Number(baseline);
  return Number.isFinite(current) && Number.isFinite(base) && base > 0 ? current / base * 100 : null;
}

function absoluteComments(book) {
  if (book.comments === null || book.comments === undefined || book.comments === '') return null;
  const comments = Number(book.comments);
  return Number.isFinite(comments) ? comments : null;
}
