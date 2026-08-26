import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const outputDirectory = path.resolve(options.out || path.join(root, '.calibration-data'));
const cohort = options.cohort === 'current' ? 'current' : 'completed';
const targetCycles = positiveInteger(options.target, 1000);
const candidateLimit = positiveInteger(options.candidates, 5500);
const requestDelayMs = nonNegativeInteger(options.delay, 1000);
const pageSize = Math.min(50, positiveInteger(options.pageSize, 50));
const recentMonths = positiveInteger(options.recentMonths, 12);
const catalogSeries = cohort === 'current' ? 'any' : 'finished';
const sortings = ['popular', 'likes', 'views', 'recent'];
const candidatesPath = path.join(outputDirectory, 'candidates.json');
const progressPath = path.join(outputDirectory, 'progress.json');
const cyclesPath = path.join(outputDirectory, 'cycles.ndjson');
fs.mkdirSync(outputDirectory, { recursive: true });

const candidates = readJson(candidatesPath, []);
const progress = readJson(progressPath, {
  version: 2,
  cohort,
  targetCycles,
  discovery: Object.fromEntries(sortings.map(sorting => [sorting, { page: 1, done: false }])),
  processedSeriesIds: [],
  rejected: [],
  blockedUntil: 0
});
if (progress.cohort && progress.cohort !== cohort) {
  throw new Error('Каталог данных уже используется для когорты "' + progress.cohort + '". Укажите другой --out.');
}
progress.version = 2;
progress.cohort = cohort;
progress.targetCycles = targetCycles;
const candidateIds = new Set(candidates.map(item => Number(item.seriesId)));
// A process may be stopped after a cycle was appended but before the next
// progress checkpoint. Treat persisted cycle records as processed on resume so
// that an interrupted collection cannot append the same series twice.
const persistedCycleIds = readNdjson(cyclesPath).map(item => Number(item.seriesId)).filter(Boolean);
const processedIds = new Set([...progress.processedSeriesIds.map(Number), ...persistedCycleIds]);
let acceptedCycles = countLines(cyclesPath);
let requestCount = Number(progress.requestCount) || 0;
let requestTail = Promise.resolve();

if (progress.blockedUntil > Date.now()) {
  console.error('Сбор приостановлен до ' + new Date(progress.blockedUntil).toLocaleString('ru-RU') + '.');
  process.exit(2);
}

const emptyListener = { addListener() {} };
const chrome = {
  extension: { inIncognitoContext: false },
  runtime: { onInstalled: emptyListener, onStartup: emptyListener, onMessage: emptyListener },
  alarms: { onAlarm: emptyListener, create() {}, async clear() {} },
  storage: { local: { async get(defaults) { return defaults || {}; }, async set() {} } }
};
const context = {
  chrome,
  fetch: politeFetch,
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Promise,
  RegExp,
  String,
  Number,
  Math,
  Set,
  Map
};
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8')
  + '\nglobalThis.__calibration = { analyzeCatalogCandidate };';
vm.runInNewContext(backgroundSource, context);
const { analyzeCatalogCandidate } = context.__calibration;

await discoverCandidates();
await collectCycles();
saveProgress();
console.log('Готово: ' + acceptedCycles + ' циклов когорты "' + cohort + '"; запросов: ' + requestCount + '.');

async function discoverCandidates() {
  while (candidates.length < candidateLimit) {
    let advanced = false;
    for (const sorting of sortings) {
      const cursor = progress.discovery[sorting] || { page: 1, done: false };
      if (cursor.done || candidates.length >= candidateLimit) continue;
      const params = new URLSearchParams({
        page: String(cursor.page),
        ps: String(pageSize),
        seriesOrder: 'first',
        series: catalogSeries,
        sorting,
        rp: 'month'
      });
      const response = await politeFetch('https://api.author.today/v1/catalog/search?' + params, {
        headers: { Authorization: 'Bearer guest' }
      });
      if (!response.ok) throw await httpError(response, 'Каталог');
      const data = await response.json();
      const results = Array.isArray(data.searchResults) ? data.searchResults : [];
      for (const candidate of results) {
        const seriesId = Number(candidate.seriesId);
        if (!seriesId || candidateIds.has(seriesId)) continue;
        candidateIds.add(seriesId);
        candidates.push({
          id: Number(candidate.id),
          seriesId,
          seriesTitle: String(candidate.seriesTitle || candidate.title || ''),
          authorFIO: String(candidate.authorFIO || '')
        });
      }
      cursor.done = Boolean(data.isLastPage) || results.length === 0;
      cursor.page += 1;
      progress.discovery[sorting] = cursor;
      writeJson(candidatesPath, candidates);
      saveProgress();
      advanced = true;
      console.log('Кандидаты: ' + candidates.length + '/' + candidateLimit + ' · ' + sorting + ' page ' + (cursor.page - 1));
    }
    if (!advanced || sortings.every(sorting => progress.discovery[sorting]?.done)) break;
  }
}

async function collectCycles() {
  for (const candidate of candidates) {
    if (acceptedCycles >= targetCycles) break;
    const seriesId = Number(candidate.seriesId);
    if (!seriesId || processedIds.has(seriesId)) continue;
    try {
      const cycle = await analyzeCatalogCandidate(candidate, []);
      const eligibility = cohortEligibility(cycle);
      if (eligibility.eligible) {
        const record = { ...cycle, calibrationCohort: cohort, calibrationEligibility: eligibility };
        fs.appendFileSync(cyclesPath, JSON.stringify(record) + '\n', 'utf8');
        acceptedCycles += 1;
      } else {
        progress.rejected.push({ seriesId, reason: eligibility.reason });
      }
      processedIds.add(seriesId);
      progress.processedSeriesIds.push(seriesId);
    } catch (error) {
      if (isBlockingError(error)) {
        progress.blockedUntil = Date.now() + 24 * 60 * 60 * 1000;
        saveProgress();
        console.error('Author.Today ограничил запросы. Чекпоинт сохранён; продолжение после ' + new Date(progress.blockedUntil).toLocaleString('ru-RU') + '.');
        process.exit(2);
      }
      processedIds.add(seriesId);
      progress.processedSeriesIds.push(seriesId);
      progress.rejected.push({ seriesId, reason: String(error.message || error).slice(0, 300) });
    }
    if (progress.processedSeriesIds.length % 10 === 0) {
      saveProgress();
      const examined = progress.processedSeriesIds.length;
      const rate = examined ? acceptedCycles / examined : 0;
      console.log('Циклы: ' + acceptedCycles + '/' + targetCycles + ' · проверено ' + examined + ' · пригодно ' + Math.round(rate * 100) + '%');
    }
  }
  if (acceptedCycles < targetCycles) {
    throw new Error('Кандидаты закончились: собрано ' + acceptedCycles + ' из ' + targetCycles + '. Увеличьте --candidates.');
  }
}

function cohortEligibility(cycle) {
  if (!cycle || !Array.isArray(cycle.books) || cycle.books.length < 3) {
    return { eligible: false, reason: 'Меньше трёх электронных томов' };
  }
  if (cohort === 'completed') {
    const eligible = cycle.status === 'completed' && Number(cycle.scores?.default?.includedCount) >= 3;
    return eligible
      ? { eligible: true, type: 'completed-control' }
      : { eligible: false, reason: 'Не прошёл базовые критерии завершённого цикла' };
  }

  const includedCount = Number(cycle.scores?.finished?.includedCount) || 0;
  if (includedCount < 3) {
    return { eligible: false, reason: 'Меньше трёх пригодных завершённых томов' };
  }
  if (cycle.status === 'ongoing') {
    return { eligible: true, type: 'ongoing-current', includedFinishedBooks: includedCount };
  }

  const finishedBooks = cycle.books.filter(book => book.isFinished !== false);
  const finalBook = finishedBooks.at(-1);
  const finalTimestamp = firstDate(finalBook?.finishedAt, finalBook?.lastUpdatedAt, finalBook?.publicationOrderAt, finalBook?.publishedAt);
  if (!Number.isFinite(finalTimestamp)) {
    return { eligible: false, reason: 'Неизвестна дата завершения последнего тома' };
  }
  const ageMonths = (Date.now() - finalTimestamp) / (365.2425 / 12 * 24 * 60 * 60 * 1000);
  if (ageMonths < 0 || ageMonths > recentMonths) {
    return { eligible: false, reason: 'Завершённый цикл старше окна актуальности ' + recentMonths + ' мес.' };
  }
  return {
    eligible: true,
    type: 'recently-completed',
    includedFinishedBooks: includedCount,
    finalBookAt: new Date(finalTimestamp).toISOString(),
    ageMonths: Math.round(ageMonths * 10) / 10
  };
}

function firstDate(...values) {
  for (const value of values) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return NaN;
}

async function politeFetch(url, init = {}) {
  const task = requestTail.then(async () => {
    const wait = Math.max(0, requestDelayMs - (Date.now() - Number(progress.lastRequestAt || 0)));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    progress.lastRequestAt = Date.now();
    requestCount += 1;
    progress.requestCount = requestCount;
    const response = await fetch(url, init);
    if (response.status === 403 || response.status === 429) throw await httpError(response, 'Author.Today');
    return response;
  });
  requestTail = task.catch(() => {});
  return task;
}

async function httpError(response, label) {
  const body = await response.clone().text().catch(() => '');
  return new Error(label + ' HTTP ' + response.status + (/(captcha|access denied)/i.test(body) ? ' CAPTCHA' : ''));
}

function isBlockingError(error) {
  return /\b(403|429)\b|captcha|access denied/i.test(String(error?.message || error));
}

function saveProgress() {
  progress.acceptedCycles = acceptedCycles;
  progress.requestCount = requestCount;
  progress.updatedAt = new Date().toISOString();
  progress.rejected = progress.rejected.slice(-5000);
  writeJson(progressPath, progress);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(values[index]);
    if (!match) continue;
    result[match[1]] = match[2] ?? values[index + 1];
    if (match[2] === undefined) index += 1;
  }
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
}

function readNdjson(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
}
