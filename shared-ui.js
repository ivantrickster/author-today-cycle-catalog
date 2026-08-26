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

async function openExtensionPage(path) {
  const url = chrome.runtime.getURL(path);
  const [existing] = await chrome.tabs.query({ url });
  if (Number.isInteger(existing?.id)) {
    if (path === 'popup.html') await chrome.tabs.reload(existing.id);
    return chrome.tabs.update(existing.id, { active: true });
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const options = { url };
  if (Number.isInteger(tab?.windowId)) options.windowId = tab.windowId;
  return chrome.tabs.create(options);
}

function ratingHint(score) {
  const adjustment = score.chronologyAdjusted ? `\nТом №${score.excludedChronologyBooks.join(', №')} исключён: дата публикации нарушает порядок томов.` : '';
  const volume = score.volumeAdjusted ? `\nТом №${score.excludedVolumeBooks.join(', №')} исключён: объём меньше 35% медианного объёма томов цикла.` : '';
  const growth = score.growthDetected ? '\nЗначения выше 100% показывают рост; дополнительных баллов за них нет.' : '';
  const transfer = score.possibleAudienceTransfer ? '\nВозможен перенос аудитории: первые два тома размещены с интервалом не более двух дней.' : '';
  const finale = score.finaleCommentSpike ? `\nУ тома №${score.finaleCommentSpike.bookNumber} отмечен необычный объём обсуждения финала.` : '';
  if (score.insufficientBooks) return `Рейтинг не рассчитан: после первого тома нужно минимум ${score.minimumBooksRequired || 3} завершённых тома. Сейчас: ${score.includedCount || 0}.${volume}${adjustment}`;
  return `Рейтинг: ${score.value ?? '—'} из 100.\n50 — обычный результат для цикла такой длины и продолжительности.\nАудитория: ${score.audiencePoints ?? 0} из 60 баллов (${percent(score.audienceRetention)} при обычных ${percent(score.expectedAudienceRetention)}).\nЛайки: ${score.likePoints ?? 0} из 40 баллов (${percent(score.likeRetention)} при обычных ${percent(score.expectedLikeRetention)}).\nКомментарии и лайки на 100 добавлений на рейтинг не влияют.${finale}${growth}${transfer}${volume}${adjustment}`;
}

function scoreNotes(score) {
  if (score.insufficientBooks) return `<div class="anomaly-note error-note">Недостаточно данных: ${score.includedCount || 0} из ${score.minimumBooksRequired || 3} необходимых томов.</div>`;
  const notes = [];
  if (score.recentTerminalVolume) notes.push(['◷', 'Последний учтённый том вышел недавно. Оценка может измениться.']);
  if (score.modelExtrapolated) notes.push(['↗', 'Цикл длиннее большинства проверенных; поправка модели ограничена.']);
  if (score.modelDatesComplete === false) notes.push(['?', 'Не хватает дат публикации; рейтинг рассчитан без поправки на время.']);
  if (score.finaleCommentSpike) notes.push(['●', `Необычный объём обсуждения финала в томе №${score.finaleCommentSpike.bookNumber}.`]);
  if (score.growthDetected) notes.push(['↑', 'К последнему учтённому тому показатели выросли.']);
  if (score.possibleAudienceTransfer) notes.push(['⇄', 'Возможен перенос аудитории между первыми томами.']);
  if (score.volumeAdjusted || score.chronologyAdjusted) notes.push(['!', 'Некоторые тома исключены из расчёта. Подробности доступны в подсказке рейтинга.']);
  return notes.length ? `<div class="signal-row">${notes.map(([icon, hint]) => `<span title="${escapeHtml(hint)}">${icon}</span>`).join('')}</div>` : '';
}

function scoreContext(score) {
  if (score.insufficientBooks) return '';
  const audienceRatio = Number.isFinite(score.audienceBenchmarkRatio)
    ? score.audienceBenchmarkRatio
    : metricBenchmarkRatio(score.audienceRetention, score.expectedAudienceRetention);
  const likeRatio = Number.isFinite(score.likeBenchmarkRatio)
    ? score.likeBenchmarkRatio
    : metricBenchmarkRatio(score.likeRetention, score.expectedLikeRetention);
  const comparison = benchmarkComparison(Number.isFinite(score.combinedBenchmarkRatio)
    ? score.combinedBenchmarkRatio
    : weightedBenchmarkRatio(audienceRatio, likeRatio));
  const tone = score.value >= 60 ? 'result-good' : score.value >= 40 ? 'result-neutral' : 'result-bad';
  const halfLife = score.audienceHalfLife?.kind === 'observed'
    ? `Половина аудитории: <strong>${durationMonths(score.audienceHalfLife.months)}</strong>`
    : score.audienceHalfLife?.kind === 'estimated'
      ? `Половина аудитории: <strong>≈ ${durationMonths(score.audienceHalfLife.months)}</strong>`
      : score.audienceHalfLife?.kind === 'growth'
        ? 'Аудитория: <strong>растёт</strong>'
        : 'Половина аудитории: <strong>нет прогноза</strong>';
  return `<div class="score-context ${tone}"><span>${comparison}</span><span>${halfLife}</span></div>`;
}

function metricBenchmarkRatio(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && expected > 0 ? actual / expected : null;
}

function weightedBenchmarkRatio(audience, likes) {
  const signals = [[audience, 60], [likes, 40]].filter(([value]) => Number.isFinite(value));
  const weight = signals.reduce((sum, [, itemWeight]) => sum + itemWeight, 0);
  return weight ? signals.reduce((sum, [value, itemWeight]) => sum + value * itemWeight, 0) / weight : null;
}

function benchmarkComparison(value) {
  if (!Number.isFinite(value)) return 'Сравнение со средним значением недоступно';
  const difference = Math.round(Math.abs(value - 1) * 100);
  if (difference < 5) return 'Удержание: на уровне среднего';
  return value > 1
    ? `Удержание: +${difference}% к среднему`
    : `Удержание: −${difference}% к среднему`;
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

async function copyCycleCardImage(cycle, score) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext('2d');
  context.fillStyle = '#17151f';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#201d29';
  context.strokeStyle = '#49415b';
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(50, 50, 1100, 530, 28);
  context.fill();
  context.stroke();

  context.fillStyle = '#bda1ff';
  context.font = '700 26px system-ui, sans-serif';
  context.fillText('AUTHOR.TODAY · РЕЙТИНГ ЦИКЛА', 100, 115);
  context.fillStyle = '#f4f0ff';
  context.font = '750 48px system-ui, sans-serif';
  drawWrappedText(context, cycle.title || 'Цикл без названия', 100, 178, 760, 58, 2);
  context.fillStyle = '#b9b2c9';
  context.font = '28px system-ui, sans-serif';
  context.fillText(cycle.author || 'Автор не указан', 100, 298);

  context.fillStyle = '#bda1ff';
  context.font = '800 118px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText(score.value ?? '—', 990, 236);
  context.fillStyle = '#aaa2b9';
  context.font = '22px system-ui, sans-serif';
  context.fillText(score.recentTerminalVolume ? 'предварительно' : 'из 100', 990, 275);
  context.textAlign = 'left';

  drawReportMetric(context, 100, 360, 'Аудитория', percent(score.audienceRetention), `${count(score.baselineLibraries)} → ${count(score.lastLibraries)}`, '#76dfa0');
  drawReportMetric(context, 470, 360, 'Лайки', percent(score.likeRetention), `${count(score.baselineLikes)} → ${count(score.lastLikes)}`, '#bda1ff');
  drawReportMetric(context, 840, 360, 'Комментарии', count(score.lastComments), `том №${score.lastBook || '—'}`, '#7fc9ff');

  context.fillStyle = '#91899f';
  context.font = '22px system-ui, sans-serif';
  const mode = `${score.finishedOnly ? 'Только завершённые' : 'Все тома'} · база с тома №${score.baselineBook || '—'}`;
  context.fillText(mode, 100, 525);
  context.textAlign = 'right';
  context.fillText(`AT Cycle Catalog ${chrome.runtime.getManifest().version}`, 1100, 525);

  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось создать изображение.')), 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

function drawReportMetric(context, x, y, label, value, detail, color) {
  context.fillStyle = '#292532';
  context.beginPath();
  context.roundRect(x, y, 320, 120, 18);
  context.fill();
  context.fillStyle = '#c9c1d6';
  context.font = '22px system-ui, sans-serif';
  context.fillText(label, x + 22, y + 34);
  context.fillStyle = color;
  context.font = '750 42px system-ui, sans-serif';
  context.fillText(value, x + 22, y + 78);
  context.fillStyle = '#91899f';
  context.font = '18px system-ui, sans-serif';
  context.fillText(detail, x + 22, y + 105);
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.…]*$/, '')}…`;
  visible.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
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
      tooltip: (book, value, index) => `${count(book.libraries)} в библиотеках · ${decimal(value)}% от базы${metricDelta(book.libraries, books[index - 1]?.libraries)}`
    },
    {
      label: 'Лайки', color: '#bda1ff', className: 'legend-likes',
      values: books.map(book => ratioPercent(book.likes, baseLikes)),
      tooltip: (book, value, index) => `${count(book.likes)} лайков · ${decimal(value)}% от базы${metricDelta(book.likes, books[index - 1]?.likes)}`
    }
  ];
  const commentSeries = [{
    label: 'Комментарии', color: '#7fc9ff', className: 'legend-comments',
    values: books.map(absoluteComments),
    tooltip: (book, value, index) => `${count(book.comments)} комментариев${metricDelta(book.comments, books[index - 1]?.comments)}`,
    finaleSpikeBook: Number(score.finaleCommentSpike?.bookNumber) || null
  }];
  const chartHelp = `Том №${score.baselineBook || 1} принят за 100%. Линия 50% показывает половину начальной аудитории. Серые точки не участвуют в рейтинге.${score.finaleCommentSpike ? ' Оранжевая точка отмечает необычное обсуждение финала.' : ''}`;
  return `<div class="chart-tools"><button class="info-button" type="button" title="${escapeHtml(chartHelp)}" aria-label="О графиках">i</button></div>
    <div class="chart-grid-layout">
      ${renderLineChart('Аудитория и лайки', books, retentionSeries, active, [50, 100], compact)}
      ${renderLineChart('Комментарии', books, commentSeries, books.map(() => true), null, compact)}
    </div>`;
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
    const tooltip = `Том №${index + 1}: ${book.title || ''}\n${item.tooltip(book, value, index, books)}${finaleSpike ? '\nНеобычный объём обсуждения финала' : muted ? '\nНе участвует в расчёте рейтинга' : ''}${clipped ? '\nТочка прижата к краю выбранной шкалы' : ''}`;
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

function metricDelta(currentValue, previousValue) {
  const current = Number(currentValue);
  const previous = Number(previousValue);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return '';
  const absolute = current - previous;
  const percentage = absolute / previous * 100;
  const sign = absolute > 0 ? '+' : absolute < 0 ? '−' : '';
  const absoluteText = `${sign}${count(Math.abs(absolute))}`;
  const percentageText = `${sign}${decimal(Math.abs(percentage))}%`;
  return `\nК предыдущему тому: ${percentageText} (${absoluteText})`;
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
