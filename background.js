const API_CONCURRENCY = 4;
const NEXT_CYCLE_MS = 500;
const PAUSE_MS = 24 * 60 * 60 * 1000;
const METRIC_VERSION = 22;
const PUBLICATION_ORDER_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const EARLY_IMPORT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const TRANSFER_GROWTH_THRESHOLD = 1.05;
const SHORT_BOOK_RATIO = 0.35;
const SHORT_BOOK_MAX_CHARS = 200_000;
const MIN_VOLUME_SAMPLE_SIZE = 3;
const MIN_RATING_BOOKS = 3;
const MODEL_BENCHMARK = 0.5;
const MODEL_MAX_TRANSITIONS = 21;
const MODEL_MAX_DURATION_MONTHS = 70;
const MODEL_MATURITY_MONTHS = 6;
// Robust fit on 300 completed Author.Today cycles (August 2026). The model
// estimates cumulative loss from transitions between toms and publication time.
const RETENTION_MODEL = {
  default: {
    audience: [0.8172999268, 0.3662175648],
    likes: [0.5431390050, 0.1985022680]
  },
  fromSecond: {
    audience: [0.3141115798, 0.4347971684],
    likes: [0.2887959611, 0.2344276046]
  }
};
const FINALE_SPIKE_LOOKBACK = 4;
const FINALE_SPIKE_MIN_REFERENCE_BOOKS = 3;
const FINALE_SPIKE_RATIO = 2;
const FINALE_SPIKE_MIN_EXCESS_COMMENTS = 100;
const SEARCH_PAGE_SIZE = 10;
const SEARCH_CONCURRENCY = 2;
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 200;
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CYCLE_STATS_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_CLEANUP_ALARM = 'storageCleanup';
const STORAGE_PREFIX = chrome.extension?.inIncognitoContext ? 'incognito:' : '';

function scopedStorageKey(key) {
  return `${STORAGE_PREFIX}${key}`;
}

async function storageGet(defaults) {
  const scopedDefaults = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [scopedStorageKey(key), value]));
  const stored = await chrome.storage.local.get(scopedDefaults);
  return Object.fromEntries(Object.keys(defaults).map(key => [key, stored[scopedStorageKey(key)]]));
}

function storageSet(values) {
  return chrome.storage.local.set(Object.fromEntries(Object.entries(values).map(([key, value]) => [scopedStorageKey(key), value])));
}

chrome.runtime.onInstalled.addListener(async () => {
  await cleanupStorage();
  chrome.alarms.create(STORAGE_CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
});
chrome.runtime.onStartup?.addListener(async () => {
  await cleanupStorage();
  chrome.alarms.create(STORAGE_CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'importUrls') importUrls(message.urls).then(reply);
  if (message.type === 'getState') getState().then(reply);
  if (message.type === 'refresh') runAllQueued().then(reply);
  if (message.type === 'clearCatalog') clearCatalog().then(reply);
  if (message.type === 'removeCycle') removeCycle(message.url).then(reply);
  if (message.type === 'addCurrentCycle') importUrls([message.url]).then(reply);
  if (message.type === 'searchCycles') searchCycles(message.filters || {}, message.cursor || { page: 1, offset: 0 }).then(reply).catch(error => reply({ status: 'error', error: error.message, results: [] }));
  if (message.type === 'getSearchState') getSearchState().then(reply);
  if (message.type === 'getGenres') getGenreCatalog().then(genres => reply({ genres })).catch(error => reply({ genres: [], error: error.message }));
  if (message.type === 'saveGenreRules') saveGenreRules(message.rules).then(reply);
  if (message.type === 'excludeCycle') excludeCycle(message.cycle, message.reason).then(reply);
  if (message.type === 'restoreExcluded') restoreExcluded(message.seriesId).then(reply);
  if (message.type === 'addSearchCycle') addSearchCycle(message.seriesId).then(reply);
  if (message.type === 'getCycleDynamics') getCycleDynamics(message.seriesId, message.url).then(reply).catch(error => reply({ status: 'error', error: error.message }));
  if (message.type === 'analyzeCurrentCycle') analyzeCurrentCycle(message.url, { force: Boolean(message.force) }).then(reply).catch(error => reply({ status: 'error', error: error.message }));
  return true;
});

async function getState() {
  const data = await storageGet({ cycles: [], queue: [], pausedUntil: 0 });
  return { ...data, pausedUntil: data.pausedUntil > Date.now() ? data.pausedUntil : 0, now: Date.now() };
}

async function cleanupStorage() {
  const now = Date.now();
  const existing = await storageGet({
    cycles: [], queue: [], pausedUntil: 0, excludedCycles: [], searchCache: {},
    genreRules: {}, genreCatalog: null, lastError: null
  });
  const cycles = Array.isArray(existing.cycles) ? existing.cycles : [];
  const queue = [...new Set((Array.isArray(existing.queue) ? existing.queue : []).map(normalizeUrl).filter(Boolean))];
  const excludedById = new Map();
  for (const item of Array.isArray(existing.excludedCycles) ? existing.excludedCycles : []) {
    const id = Number(item?.seriesId);
    if (id && !excludedById.has(id)) excludedById.set(id, item);
  }
  const genreCatalogFresh = isFreshTimestamp(existing.genreCatalog?.cachedAt, GENRE_CACHE_TTL_MS, now);
  const genreCatalog = genreCatalogFresh && Array.isArray(existing.genreCatalog?.genres) ? existing.genreCatalog : null;
  let genreRules = normalizeGenreRules(existing.genreRules);
  if (genreCatalog?.genres?.length) {
    const validGenreIds = new Set(genreCatalog.genres.map(genre => String(Number(genre.id))));
    genreRules = Object.fromEntries(Object.entries(genreRules).filter(([id]) => validGenreIds.has(id)));
  }
  await storageSet({
    cycles,
    queue,
    pausedUntil: existing.pausedUntil > now ? existing.pausedUntil : 0,
    excludedCycles: [...excludedById.values()],
    searchCache: pruneSearchCache(existing.searchCache, now),
    genreRules,
    genreCatalog,
    lastError: typeof existing.lastError === 'string' ? existing.lastError.slice(0, 1000) : null
  });
  return { cleaned: true };
}

function pruneSearchCache(cache, now = Date.now()) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {};
  return Object.fromEntries(Object.entries(cache)
    .filter(([, entry]) => entry?.cycle?.metricVersion === METRIC_VERSION && isFreshTimestamp(entry.cachedAt, SEARCH_CACHE_TTL_MS, now))
    .sort(([, a], [, b]) => Date.parse(b.cachedAt) - Date.parse(a.cachedAt))
    .slice(0, SEARCH_CACHE_LIMIT));
}

function isFreshTimestamp(value, ttl, now = Date.now()) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60 * 1000 && now - timestamp < ttl;
}

function isCycleStale(cycle, now = Date.now()) {
  return cycle?.metricVersion !== METRIC_VERSION || !isFreshTimestamp(cycle?.updatedAt, CYCLE_STATS_TTL_MS, now);
}

async function importUrls(urls) {
  const valid = [...new Set(urls.map(normalizeUrl).filter(Boolean))];
  const { cycles = [], queue = [] } = await storageGet({ cycles: [], queue: [] });
  const known = new Set([...cycles.map(c => c.url), ...queue]);
  const add = valid.filter(url => !known.has(url));
  await storageSet({ queue: [...queue, ...add] });
  return { added: add.length };
}

async function clearCatalog() {
  await storageSet({ cycles: [], queue: [], pausedUntil: 0, lastError: null });
  return { cleared: true };
}

async function removeCycle(url) {
  const { cycles = [], queue = [] } = await storageGet({ cycles: [], queue: [] });
  await storageSet({ cycles: cycles.filter(c => c.url !== url), queue: queue.filter(item => item !== url) });
  return { removed: true };
}

async function getSearchState() {
  const { excludedCycles = [], genreRules = {} } = await storageGet({ excludedCycles: [], genreRules: {} });
  return { excludedCycles: [...excludedCycles].sort((a, b) => Date.parse(b.hiddenAt) - Date.parse(a.hiddenAt)), genreRules: normalizeGenreRules(genreRules) };
}

async function saveGenreRules(rules) {
  const genreRules = normalizeGenreRules(rules);
  await storageSet({ genreRules });
  return { saved: true, genreRules };
}

async function getGenreCatalog() {
  const { genreCatalog = null } = await storageGet({ genreCatalog: null });
  if (genreCatalog?.genres?.length && isFreshTimestamp(genreCatalog.cachedAt, GENRE_CACHE_TTL_MS)) return genreCatalog.genres;
  try {
    const response = await fetch('https://api.author.today/v1/work/genres', { headers: { Authorization: 'Bearer guest' } });
    if (!response.ok) throw new Error(`Жанры API HTTP ${response.status}`);
    const genres = (await response.json()).map(genre => ({
      id: Number(genre.id),
      parentId: genre.parentId === null ? null : Number(genre.parentId),
      title: String(genre.title || ''),
      code: String(genre.code || ''),
      workCount: Number(genre.workCount) || 0
    })).filter(genre => genre.id && genre.title);
    const { genreRules = {} } = await storageGet({ genreRules: {} });
    const validGenreIds = new Set(genres.map(genre => String(genre.id)));
    const cleanedRules = Object.fromEntries(Object.entries(normalizeGenreRules(genreRules)).filter(([id]) => validGenreIds.has(id)));
    await storageSet({ genreCatalog: { genres, cachedAt: new Date().toISOString() }, genreRules: cleanedRules });
    return genres;
  } catch (error) {
    await storageSet({ genreCatalog: null });
    throw error;
  }
}

async function excludeCycle(cycle, reason) {
  const seriesId = Number(cycle?.seriesId);
  if (!seriesId || !['ignored', 'read'].includes(reason)) return { excluded: false };
  const { excludedCycles = [] } = await storageGet({ excludedCycles: [] });
  const entry = {
    seriesId,
    title: String(cycle.title || `Цикл ${seriesId}`),
    author: String(cycle.author || 'Автор не указан'),
    url: `https://author.today/work/series/${seriesId}`,
    reason,
    hiddenAt: new Date().toISOString()
  };
  await storageSet({ excludedCycles: [entry, ...excludedCycles.filter(item => Number(item.seriesId) !== seriesId)] });
  return { excluded: true };
}

async function restoreExcluded(seriesId) {
  const id = Number(seriesId);
  const { excludedCycles = [] } = await storageGet({ excludedCycles: [] });
  await storageSet({ excludedCycles: excludedCycles.filter(item => Number(item.seriesId) !== id) });
  return { restored: true };
}

async function addSearchCycle(seriesId) {
  const id = Number(seriesId);
  const { searchCache = {}, cycles = [], queue = [] } = await storageGet({ searchCache: {}, cycles: [], queue: [] });
  const cleanedCache = pruneSearchCache(searchCache);
  const cycle = cleanedCache[id]?.cycle;
  if (Object.keys(cleanedCache).length !== Object.keys(searchCache).length) await storageSet({ searchCache: cleanedCache });
  if (!cycle) return { added: false, reason: 'not-cached' };
  if (cycles.some(item => Number(item.seriesId) === id || item.url === cycle.url)) return { added: false, reason: 'exists' };
  await storageSet({ cycles: [cycle, ...cycles], queue: queue.filter(url => url !== cycle.url) });
  return { added: true };
}

async function getCycleDynamics(seriesId, url) {
  const id = Number(seriesId);
  const state = await storageGet({ searchCache: {}, cycles: [] });
  const cycleIndex = state.cycles.findIndex(item => (id && Number(item.seriesId) === id) || (url && item.url === url));
  let cycle = (id && state.searchCache[id]?.cycle) || (cycleIndex >= 0 ? state.cycles[cycleIndex] : null);
  if (!cycle?.books?.length) return { status: 'not-found' };
  const fresh = isFreshTimestamp(cycle.dynamicsUpdatedAt, CYCLE_STATS_TTL_MS);
  const complete = cycle.books.every(book => isFiniteMetric(book.libraries));
  if (!fresh || !complete) {
    const books = cycle.books.map(book => ({ ...book }));
    const indexedBooks = books.map((book, index) => ({ book, index }));
    const stats = await mapWithConcurrency(indexedBooks, 2, async ({ book, index }) => {
      const workId = Number(/\/work\/(\d+)/.exec(book.url || '')?.[1]);
      if (!workId) return { index, stats: null };
      return { index, stats: await fetchLibraryStats(workId) };
    });
    for (const item of stats) books[item.index].libraries = libraryAudienceCount(item.stats);
    const now = new Date().toISOString();
    const scores = calculateAllScores(books, { cycleCompleted: cycle.status === 'completed' });
    cycle = { ...cycle, books, scores, score: scores.default, metricVersion: METRIC_VERSION, updatedAt: now, dynamicsUpdatedAt: now };
    const nextCycles = [...state.cycles];
    if (cycleIndex >= 0) nextCycles[cycleIndex] = cycle;
    const nextCache = { ...state.searchCache };
    if (id && nextCache[id]) nextCache[id] = { cycle, cachedAt: now };
    await storageSet({ cycles: nextCycles, searchCache: pruneSearchCache(nextCache) });
  }
  return { status: 'ready', cycle };
}

async function analyzeCurrentCycle(value, { force = false } = {}) {
  const state = await storageGet({ cycles: [], searchCache: {}, pausedUntil: 0 });
  if (state.pausedUntil > Date.now()) return { status: 'paused', until: state.pausedUntil };
  const resolved = await resolveCyclePage(value, state);
  if (resolved.status !== 'ready') return resolved;
  const { url, seriesId } = resolved;
  const stored = state.cycles.find(cycle => Number(cycle.seriesId) === seriesId || cycle.url === url);
  const cached = state.searchCache?.[seriesId]?.cycle;
  let cycle = force ? null : [stored, cached].find(item => item && !isCycleStale(item));
  if (!cycle) {
    cycle = await scanCycle(url);
    const cachedAt = new Date().toISOString();
    const searchCache = pruneSearchCache({
      ...state.searchCache,
      [seriesId]: { cycle, cachedAt }
    });
    const cycles = stored
      ? state.cycles.map(item => Number(item.seriesId) === seriesId || item.url === url ? cycle : item)
      : state.cycles;
    await storageSet({ searchCache, cycles });
  }
  return {
    status: 'ready',
    cycle,
    inCatalog: state.cycles.some(item => Number(item.seriesId) === seriesId || item.url === url)
  };
}

async function resolveCyclePage(value, state = { cycles: [], searchCache: {} }) {
  const directUrl = normalizeUrl(value);
  if (directUrl) return { status: 'ready', url: directUrl, seriesId: Number(/\/series\/(\d+)/.exec(directUrl)?.[1]) || 0 };
  const bookMatch = /^https:\/\/author\.today\/work\/(\d+)(?:[/?#]|$)/i.exec(String(value || ''));
  if (!bookMatch) return { status: 'invalid-page' };
  const workId = Number(bookMatch[1]);
  const knownCycles = [
    ...(Array.isArray(state.cycles) ? state.cycles : []),
    ...Object.values(state.searchCache || {}).map(entry => entry?.cycle).filter(Boolean)
  ];
  const known = knownCycles.find(cycle => (cycle.books || []).some(book => Number(/\/work\/(\d+)/.exec(book.url || '')?.[1]) === workId));
  if (known?.seriesId) return { status: 'ready', url: `https://author.today/work/series/${known.seriesId}`, seriesId: Number(known.seriesId) };
  const work = await fetchApiWorkDetails(workId);
  const seriesId = Number(work.seriesId) || 0;
  const seriesWorkIds = [...new Set((work.seriesWorkIds || []).map(Number).filter(Boolean))];
  if (!seriesId || seriesWorkIds.length < 2) return { status: 'standalone', bookTitle: work.title || `Том ${workId}` };
  return { status: 'ready', url: `https://author.today/work/series/${seriesId}`, seriesId };
}

async function searchCycles(filters, cursor) {
  const { pausedUntil = 0, excludedCycles = [], searchCache = {} } = await storageGet({ pausedUntil: 0, excludedCycles: [], searchCache: {} });
  const startCursor = {
    page: Math.max(1, Number(cursor?.page) || 1),
    offset: Math.max(0, Number(cursor?.offset) || 0)
  };
  if (pausedUntil > Date.now()) return { status: 'paused', until: pausedUntil, cursor: startCursor, checked: 0, skipped: 0, results: [], isLastPage: false };
  const excludedIds = new Set(excludedCycles.map(item => Number(item.seriesId)));
  const genreRules = normalizeGenreRules(filters.genreRules);
  const genreCatalog = Object.keys(genreRules).length
    ? await getGenreCatalog()
    : await getGenreCatalog().catch(() => []);
  const minBookLikes = Math.max(0, Number(filters.minBookLikes) || 0);
  const now = Date.now();
  const nextCache = pruneSearchCache(searchCache, now);
  const results = [];
  let page = startCursor.page;
  let offset = startCursor.offset;
  let checked = 0;
  let skipped = 0;
  let totalCount = 0;
  let blocked = null;
  let catalogExhausted = false;

  while (results.length < SEARCH_PAGE_SIZE && !blocked && !catalogExhausted) {
    const catalog = await fetchCatalogPage(filters, page);
    const rawCandidates = catalog.searchResults || [];
    totalCount = catalog.realTotalCount || totalCount;

    while (offset < rawCandidates.length && results.length < SEARCH_PAGE_SIZE && !blocked) {
      const candidates = [];
      const capacity = Math.min(SEARCH_CONCURRENCY, SEARCH_PAGE_SIZE - results.length);
      while (offset < rawCandidates.length && candidates.length < capacity) {
        const candidate = rawCandidates[offset++];
        if (!candidate.seriesId || excludedIds.has(Number(candidate.seriesId))) continue;
        if (!matchesGenreRules(candidate, genreRules, genreCatalog)) continue;
        if (minBookLikes && (Number(candidate.likeCount) || 0) <= minBookLikes) continue;
        candidates.push(candidate);
      }
      if (!candidates.length) continue;

      const analyses = await mapWithConcurrency(candidates, SEARCH_CONCURRENCY, async candidate => {
        const cached = nextCache[candidate.seriesId];
        if (cached?.cycle?.metricVersion === METRIC_VERSION && now - Date.parse(cached.cachedAt) < SEARCH_CACHE_TTL_MS) return { cycle: cached.cycle };
        try {
          return { cycle: await analyzeCatalogCandidate(candidate, genreCatalog) };
        } catch (error) {
          return { error: error.message, blocked: /429|403|captcha|access denied/i.test(error.message) };
        }
      });
      checked += candidates.length;
      skipped += analyses.filter(item => item.error).length;
      blocked = analyses.find(item => item.blocked) || null;
      for (const analysis of analyses) {
        if (!analysis.cycle) continue;
        nextCache[analysis.cycle.seriesId] = { cycle: analysis.cycle, cachedAt: new Date().toISOString() };
        if (matchesSearchFilters(analysis.cycle, filters)) results.push(analysis.cycle);
      }
    }

    if (offset >= rawCandidates.length) {
      if (catalog.isLastPage || rawCandidates.length === 0) catalogExhausted = true;
      else {
        page += 1;
        offset = 0;
      }
    }
  }

  // Keep every displayed card addable even when strict filters required scanning
  // more candidates than the cache limit.
  for (const cycle of results) nextCache[cycle.seriesId] = { cycle, cachedAt: new Date().toISOString() };
  const trimmedCache = pruneSearchCache(nextCache);
  const nextPausedUntil = blocked ? Date.now() + PAUSE_MS : pausedUntil;
  await storageSet({ searchCache: trimmedCache, pausedUntil: nextPausedUntil });
  return {
    status: blocked ? 'paused' : 'ok',
    until: blocked ? nextPausedUntil : 0,
    cursor: { page, offset },
    checked,
    skipped,
    results,
    isLastPage: catalogExhausted,
    totalCount
  };
}

async function fetchCatalogPage(filters, page) {
  const series = filters.status === 'completed' ? 'finished' : filters.status === 'ongoing' ? 'unfinished' : 'any';
  const sorting = ['popular', 'recent', 'likes', 'views'].includes(filters.sorting) ? filters.sorting : 'popular';
  const params = new URLSearchParams({
    page: String(Math.max(1, Number(page) || 1)),
    ps: String(SEARCH_PAGE_SIZE),
    seriesOrder: 'first',
    series,
    sorting,
    rp: 'month'
  });
  const response = await fetch(`https://api.author.today/v1/catalog/search?${params}`, { headers: { Authorization: 'Bearer guest' } });
  if (!response.ok) throw new Error(`Каталог API HTTP ${response.status}`);
  return response.json();
}

async function analyzeCatalogCandidate(candidate, genreCatalog = []) {
  const firstRaw = await fetchApiWorkDetails(candidate.id);
  const ids = [...new Set((firstRaw.seriesWorkIds || [candidate.id]).map(Number).filter(Boolean))];
  if (ids.length < 2) throw new Error('В цикле меньше двух томов');
  const metaItems = await fetchSeriesMeta(ids);
  const metaById = new Map(metaItems.map(item => [Number(item.id), item]));
  const books = ids
    .map(id => workMetaToBook(metaById.get(id) || (id === Number(firstRaw.id) ? firstRaw : { id })))
    .filter(book => !isAudiobook(book));
  if (books.length < 2) throw new Error('В цикле меньше двух электронных томов');
  const cycleCompleted = books.every(book => book.isFinished !== false);
  const firstBookId = Number(/\/work\/(\d+)/.exec(books[0].url)?.[1]);
  const firstBookRaw = firstBookId === Number(firstRaw.id) ? firstRaw : await fetchApiWorkDetails(firstBookId);
  books[0].publishedAt = earliestChapterDate(firstBookRaw) || firstBookRaw.lastModificationTime || null;
  const relevantIndices = new Set();
  for (const startIndex of [0, 1]) {
    for (const finishedOnly of [false, true]) {
      const indexed = books.map((book, index) => ({ ...book, cycleIndex: index }));
      const analyzed = indexed
        .filter(book => book.cycleIndex >= startIndex && (!finishedOnly || book.isFinished !== false));
      const volumeReference = indexed.filter(book => !finishedOnly || book.isFinished !== false);
      const withoutShortBooks = excludeAbnormallyShortBooks(analyzed, volumeReference).books;
      const consistent = selectChronologicallyConsistentBooks(withoutShortBooks).books;
      relevantIndices.add(consistent[0]?.cycleIndex);
      relevantIndices.add(consistent.at(-1)?.cycleIndex);
    }
  }
  if (cycleCompleted) {
    for (let index = Math.max(0, books.length - FINALE_SPIKE_LOOKBACK - 1); index < books.length; index += 1) relevantIndices.add(index);
  }
  const validIndices = [...relevantIndices].filter(index => Number.isInteger(index) && index >= 0 && index < books.length);
  const libraryStats = await mapWithConcurrency(validIndices, API_CONCURRENCY, async index => {
    const workId = Number(/\/work\/(\d+)/.exec(books[index].url)?.[1]);
    return { index, stats: await fetchLibraryStats(workId) };
  });
  for (const { index, stats } of libraryStats) books[index].libraries = libraryAudienceCount(stats);
  const scores = calculateAllScores(books, { cycleCompleted });
  const duration = calculateCycleDuration(books);
  const seriesId = Number(candidate.seriesId);
  const genreIds = [...new Set([
    firstBookRaw.genreId ?? candidate.genreId,
    firstBookRaw.firstSubGenreId ?? candidate.firstSubGenreId,
    firstBookRaw.secondSubGenreId ?? candidate.secondSubGenreId
  ].map(Number).filter(Boolean))].slice(0, 3);
  const genreById = new Map(genreCatalog.map(genre => [Number(genre.id), genre.title]));
  return {
    seriesId,
    url: `https://author.today/work/series/${seriesId}`,
    title: candidate.seriesTitle || firstRaw.seriesTitle || candidate.title,
    author: [candidate.authorFIO, candidate.coAuthorFIO, candidate.secondCoAuthorFIO].filter(Boolean).join(', ') || 'Автор не указан',
    genres: genreIds.map(id => genreById.get(id)).filter(Boolean),
    status: cycleCompleted ? 'completed' : 'ongoing',
    books,
    ...duration,
    score: scores.default,
    scores,
    metricVersion: METRIC_VERSION,
    updatedAt: new Date().toISOString()
  };
}

async function fetchApiWorkDetails(id) {
  const response = await fetch(`https://api.author.today/v1/work/${id}/details`, { headers: { Authorization: 'Bearer guest' } });
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  return response.json();
}

async function fetchSeriesMeta(ids) {
  const chunks = [];
  for (let start = 0; start < ids.length; start += 50) chunks.push(ids.slice(start, start + 50));
  const pages = await mapWithConcurrency(chunks, 2, async chunk => {
    const params = new URLSearchParams();
    chunk.forEach((id, index) => params.append(`ids[${index}]`, String(id)));
    const response = await fetch(`https://api.author.today/v1/work/meta-info?${params}`, { headers: { Authorization: 'Bearer guest' } });
    if (!response.ok) throw new Error(`Метаданные API HTTP ${response.status}`);
    return response.json();
  });
  return pages.flat().map(item => item?.data || item).filter(item => item?.id);
}

function earliestChapterDate(work) {
  return (work.chapters || []).map(chapter => chapter.publishTime)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
}

function workMetaToBook(work) {
  return {
    url: `https://author.today/work/${work.id}`,
    title: work.title || `Том ${work.id}`,
    views: work.viewCount ?? null,
    likes: work.likeCount ?? null,
    libraries: null,
    comments: work.commentCount ?? null,
    textLength: work.textLength ?? null,
    publishedAt: work.publishTime || work.publicationTime || null,
    publicationOrderAt: work.finishTime || work.lastModificationTime || null,
    lastUpdatedAt: work.lastUpdateTime || work.lastModificationTime || work.finishTime || null,
    isFinished: work.isFinished ?? work.finished ?? false,
    status: work.status || null,
    price: work.price ?? null,
    genreIds: workGenreIds(work),
    format: work.format || null,
    chapterCount: Array.isArray(work.chapters) ? work.chapters.length : (work.chapterCount ?? null)
  };
}

function isAudiobook(work) {
  return String(work?.format || '').toLowerCase() === 'audiobook';
}

function workGenreIds(work) {
  return [...new Set([work?.genreId, work?.firstSubGenreId, work?.secondSubGenreId].map(Number).filter(Boolean))].slice(0, 3);
}

function genreTitles(ids, catalog) {
  const genreById = new Map((catalog || []).map(genre => [Number(genre.id), genre.title]));
  return (ids || []).map(id => genreById.get(Number(id))).filter(Boolean).slice(0, 3);
}

function scoreForSearch(cycle, filters) {
  const key = filters.finishedOnly ? (filters.fromSecond ? 'finishedFromSecond' : 'finished') : (filters.fromSecond ? 'fromSecond' : 'default');
  return cycle.scores?.[key] || cycle.score || {};
}

function normalizeGenreRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return {};
  return Object.fromEntries(Object.entries(rules)
    .map(([id, state]) => [String(Number(id)), state])
    .filter(([id, state]) => Number(id) > 0 && ['include', 'exclude', 'neutral'].includes(state)));
}

function matchesGenreRules(candidate, rules, genres) {
  const normalized = normalizeGenreRules(rules);
  const ruleEntries = Object.entries(normalized);
  if (!ruleEntries.length) return true;
  const genreById = new Map((genres || []).map(genre => [Number(genre.id), genre]));
  const assignedGenreIds = [...new Set([candidate.genreId, candidate.firstSubGenreId, candidate.secondSubGenreId].map(Number).filter(Boolean))];
  // Author.Today can assign independent genres from different branches (for
  // example RealRPG together with two Science Fiction subgenres). Keep all of
  // those, but omit a broad parent when the same work also carries one of its
  // descendants so a user's child override remains effective.
  const candidateGenreIds = assignedGenreIds.filter(id =>
    !assignedGenreIds.some(otherId => otherId !== id && isGenreAncestor(id, otherId, genreById))
  );
  const effectiveStates = candidateGenreIds.map(id => effectiveGenreRule(id, normalized, genreById)).filter(Boolean);
  if (effectiveStates.includes('exclude')) return false;
  const hasIncludeRule = ruleEntries.some(([, state]) => state === 'include');
  return !hasIncludeRule || effectiveStates.includes('include');
}

function isGenreAncestor(ancestorId, childId, genreById) {
  let currentId = Number(genreById.get(Number(childId))?.parentId) || 0;
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    if (currentId === Number(ancestorId)) return true;
    visited.add(currentId);
    currentId = Number(genreById.get(currentId)?.parentId) || 0;
  }
  return false;
}

function effectiveGenreRule(id, rules, genreById) {
  let currentId = Number(id);
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const direct = rules[String(currentId)];
    if (direct) return direct === 'neutral' ? null : direct;
    currentId = Number(genreById.get(currentId)?.parentId) || 0;
  }
  return null;
}

function matchesSearchFilters(cycle, filters) {
  const score = scoreForSearch(cycle, filters);
  const minScore = Number(filters.minScore) || 0;
  const minAudience = (Number(filters.minAudienceRetention) || 0) / 100;
  const minLikes = (Number(filters.minLikeRetention) || 0) / 100;
  const minBookLikes = Math.max(0, Number(filters.minBookLikes) || 0);
  const minBooks = Math.max(0, Number(filters.minBooks) || 0);
  return Number.isFinite(score.value)
    && (filters.status === 'all' || cycle.status === filters.status)
    && (!minScore || (Number.isFinite(score.value) && score.value > minScore))
    && (!minAudience || (Number.isFinite(score.audienceRetention) && score.audienceRetention > minAudience))
    && (!minLikes || (Number.isFinite(score.likeRetention) && score.likeRetention > minLikes))
    && (!minBookLikes || (Number.isFinite(cycle.books[0]?.likes) && cycle.books[0].likes > minBookLikes))
    && (!minBooks || cycle.books.length > minBooks);
}

function normalizeUrl(value) {
  const match = String(value).match(/https:\/\/author\.today\/work\/series\/\d+/i);
  return match ? match[0].replace(/\/$/, '') : null;
}

async function runAllQueued() {
  await chrome.alarms.clear('nextScan');
  let scanned = 0, skipped = 0;
  while (true) {
    const result = await runQueue({ scheduleNext: false });
    if (result.status === 'scanned') scanned += 1;
    if (result.status === 'skipped') skipped += 1;
    if (result.status === 'paused') return { ...result, scanned, skipped };
    const state = await getState();
    if (!state.queue.length) return scanned ? { status: 'scanned', scanned, skipped } : result;
    await delay(NEXT_CYCLE_MS);
  }
}

async function runQueue({ scheduleNext = true } = {}) {
  let state = await getState();
  if (state.pausedUntil > Date.now()) return { status: 'paused', until: state.pausedUntil };
  if (!state.queue.length) {
    const incomplete = state.cycles.filter(cycle => isCycleStale(cycle)).map(cycle => cycle.url);
    if (!incomplete.length) return { status: 'empty' };
    await storageSet({ queue: incomplete });
    state = { ...state, queue: incomplete };
  }
  const url = state.queue[0];
  try {
    const cycle = await scanCycle(url);
    const existingIndex = state.cycles.findIndex(item => item.url === url);
    const nextCycles = [...state.cycles];
    if (existingIndex >= 0) nextCycles[existingIndex] = cycle;
    else nextCycles.unshift(cycle);
    await storageSet({ cycles: nextCycles, queue: state.queue.slice(1), lastError: null });
    if (scheduleNext && state.queue.length > 1) chrome.alarms.create('nextScan', { when: Date.now() + NEXT_CYCLE_MS });
    return { status: 'scanned', cycle };
  } catch (error) {
    const pause = /429|403|captcha|access denied/i.test(error.message);
    await storageSet({
      queue: state.queue.slice(1),
      pausedUntil: pause ? Date.now() + PAUSE_MS : 0,
      lastError: `${url}: ${error.message}`
    });
    if (!pause && scheduleNext && state.queue.length > 1) chrome.alarms.create('nextScan', { when: Date.now() + NEXT_CYCLE_MS });
    return { status: pause ? 'paused' : 'skipped', error: error.message };
  }
}

chrome.alarms.onAlarm.addListener(async alarm => {
  const { privacyConsent } = await storageGet({ privacyConsent: null });
  if (privacyConsent?.version !== 1) return;
  if (alarm.name === 'nextScan') runQueue();
  if (alarm.name === STORAGE_CLEANUP_ALARM) cleanupStorage();
});

async function scanCycle(url) {
  const html = await fetchText(url);
  const cycle = parseCyclePage(html, url);
  const firstWorkId = Number(/\/work\/(\d+)/.exec(cycle.bookUrls[0] || '')?.[1]);
  const firstWork = firstWorkId ? await fetchApiWorkDetails(firstWorkId) : null;
  const apiIds = [...new Set((firstWork?.seriesWorkIds || []).map(Number).filter(Boolean))];
  const metaItems = apiIds.length ? await fetchSeriesMeta(apiIds) : [];
  const metaById = new Map(metaItems.map(item => [Number(item.id), item]));
  const ebookIds = apiIds.filter(id => !isAudiobook(metaById.get(id)));
  const apiBookUrls = ebookIds.map(id => `https://author.today/work/${id}`);
  const bookUrls = apiBookUrls.length ? apiBookUrls : cycle.bookUrls;
  const books = await mapWithConcurrency(bookUrls, API_CONCURRENCY, fetchWorkDetails);
  if (books.length < 2) throw new Error('На странице не удалось найти минимум два тома цикла');
  const scores = calculateAllScores(books, { cycleCompleted: cycle.status === 'completed' });
  const duration = calculateCycleDuration(books);
  const genres = genreTitles(books[0]?.genreIds, await getGenreCatalog().catch(() => []));
  const updatedAt = new Date().toISOString();
  return { ...cycle, bookUrls, books, genres, ...duration, score: scores.default, scores, metricVersion: METRIC_VERSION, updatedAt, dynamicsUpdatedAt: updatedAt };
}

function calculateAllScores(books, { cycleCompleted = false } = {}) {
  return {
    default: calculateScore(books, { cycleCompleted }),
    fromSecond: calculateScore(books, { startIndex: 1, cycleCompleted }),
    finished: calculateScore(books, { finishedOnly: true, cycleCompleted }),
    finishedFromSecond: calculateScore(books, { startIndex: 1, finishedOnly: true, cycleCompleted })
  };
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchWorkDetails(url) {
  const id = /\/work\/(\d+)/.exec(url)?.[1];
  if (!id) throw new Error('Не удалось определить номер тома');
  const [response, libraryStats] = await Promise.all([
    fetch(`https://api.author.today/v1/work/${id}/details`, { headers: { Authorization: 'Bearer guest' } }),
    fetchLibraryStats(id)
  ]);
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  const work = await response.json();
  const publishedAt = (work.chapters || [])
    .map(chapter => chapter.publishTime)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || work.lastModificationTime || null;
  return {
    url,
    title: work.title || url,
    views: null,
    likes: work.likeCount ?? null,
    libraries: libraryAudienceCount(libraryStats),
    comments: work.commentCount ?? null,
    textLength: work.textLength ?? null,
    publishedAt,
    publicationOrderAt: work.finishTime || work.lastModificationTime || publishedAt,
    lastUpdatedAt: work.lastUpdateTime || work.lastModificationTime || work.finishTime || null,
    isFinished: work.isFinished ?? false,
    status: work.status || null,
    price: work.price ?? null,
    genreIds: workGenreIds(work),
    format: work.format || null,
    chapterCount: Array.isArray(work.chapters) ? work.chapters.length : (work.chapterCount ?? null)
  };
}

async function fetchLibraryStats(id) {
  try {
    const response = await fetch(`https://author.today/work/work-stats?workId=${id}`, {
      credentials: 'omit',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (response.status === 403 || response.status === 429) throw new Error(`Статистика HTTP ${response.status}`);
    if (!response.ok) return null;
    const result = await response.json();
    return result.isSuccessful ? result.data : null;
  } catch (error) {
    if (/429|403/.test(error.message)) throw error;
    return null;
  }
}

function libraryAudienceCount(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const includedRaw = [stats.readingCount, stats.savedCount, stats.finishedCount];
  if (includedRaw.every(isFiniteMetric)) return includedRaw.reduce((sum, value) => sum + Number(value), 0);
  return isFiniteMetric(stats.totalCount) ? Number(stats.totalCount) : null;
}

function parseCyclePage(html, url) {
  const text = htmlToText(html);
  const title = (extractTag(html, 'h1') || url).replace(/^Цикл\s*[«"]?|[»"]$/g, '').trim();
  const authorMatch = /<a[^>]+href=["'][^"']*\/u\/[^"']+\/series[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  const author = authorMatch ? htmlToText(authorMatch[1]).trim() : 'Автор не указан';
  const status = /не\s*завершен/i.test(text) ? 'ongoing' : /завершен/i.test(text) ? 'completed' : 'ongoing';
  const bookUrls = [...new Set([...html.matchAll(/href=["'](?:https:\/\/author\.today)?(\/work\/\d+)["']/gi)]
    .map(match => `https://author.today${match[1]}`))];
  const seriesId = Number(/\/series\/(\d+)/.exec(url || '')?.[1]) || null;
  return { seriesId, url, title, author, status, bookUrls };
}

function parseBookPage(html, url) {
  const text = htmlToText(html).replace(/\u00a0/g, ' ');
  const title = extractTag(html, 'h1') || url;
  return {
    url, title,
    views: findHtmlStat(html, /data-hint=["'][^"']*Просмотры\s*[·•]\s*([^"']+)/i),
    likes: findHtmlStat(html, /class=["'][^"']*like-count[^"']*["'][^>]*>\s*([^<]+)/i),
    libraries: findLabeled(text, ['Добавили в библиотеку', 'Библиотеки']),
    comments: findHtmlStat(html, /Комментарии\s*[·:]\s*([\d ]+)/i)
  };
}

function extractTag(html, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return match ? htmlToText(match[1]).trim() : null;
}
function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&laquo;/gi, '«').replace(/&raquo;/gi, '»').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\n{2,}/g, '\n');
}


function findLabeled(text, labels) {
  for (const label of labels) {
    const after = new RegExp(`${label}[\\s:]*([\\d][\\d .,.]*[KMG]?)`, 'i').exec(text);
    const before = new RegExp(`([\\d][\\d .,.]*[KMG]?)\\s*${label}`, 'i').exec(text);
    const found = after?.[1] || before?.[1];
    if (found) { const value = parseNumber(found); if (value !== null) return value; }
  }
  return null;
}

function findHtmlStat(html, pattern) { const found = pattern.exec(html)?.[1]; return found ? parseNumber(htmlToText(found)) : null; }
function findStat(text, regex) { const result = regex.exec(text); return result ? parseNumber(result[1]) : null; }
function parseNumber(value) {
  const clean = String(value).replace(/\s/g, '').replace(',', '.');
  if (!clean || !/[\d]/.test(clean)) return null;
  const suffix = (clean.at(-1) || '').toUpperCase();
  const multiplier = suffix === 'K' || suffix === 'К' ? 1e3 : suffix === 'M' || suffix === 'М' ? 1e6 : suffix === 'G' || suffix === 'Г' ? 1e9 : 1;
  return Math.round(parseFloat(clean) * multiplier) || null;
}
function ratio(a, b) {
  return isFiniteMetric(a) && isFiniteMetric(b) && Number(b) > 0 ? Number(a) / Number(b) : null;
}
function isFiniteMetric(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}
function plural(value, forms) {
  const tens = value % 100, units = value % 10;
  return tens >= 11 && tens <= 14 ? forms[2] : units === 1 ? forms[0] : units >= 2 && units <= 4 ? forms[1] : forms[2];
}
function formatDuration(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const days = (end - start) / (24 * 60 * 60 * 1000);
  if (days < 30) return 'менее месяца';
  const startDate = new Date(start), endDate = new Date(end);
  let calendarMonths = (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth();
  const endMonthProgress = endDate.getUTCDate() + endDate.getUTCHours() / 24;
  const startMonthProgress = startDate.getUTCDate() + startDate.getUTCHours() / 24;
  if (endMonthProgress < startMonthProgress) calendarMonths -= 1;
  const totalMonths = Math.max(1, calendarMonths);
  const years = Math.floor(totalMonths / 12), months = totalMonths % 12;
  const parts = [];
  if (years) parts.push(`${years} ${plural(years, ['год', 'года', 'лет'])}`);
  if (months) parts.push(`${months} ${plural(months, ['месяц', 'месяца', 'месяцев'])}`);
  return parts.join(' ');
}
function calculateCycleDuration(books) {
  const startedAt = books[0]?.publishedAt || null;
  const lastUpdatedAt = books.at(-1)?.lastUpdatedAt || null;
  const start = Date.parse(startedAt), end = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { durationYears: null, durationLabel: '—', cycleStartedAt: startedAt, cycleLastUpdatedAt: lastUpdatedAt };
  }
  const yearMs = 365.2425 * 24 * 60 * 60 * 1000;
  return {
    durationYears: Math.round(((end - start) / yearMs) * 10) / 10,
    durationLabel: formatDuration(start, end),
    cycleStartedAt: startedAt,
    cycleLastUpdatedAt: lastUpdatedAt
  };
}
function calculateScore(books, { startIndex = 0, finishedOnly = false, cycleCompleted = false } = {}) {
  const indexedBooks = books.map((book, index) => ({ ...book, cycleIndex: index }));
  const analyzedBooks = indexedBooks
    .filter(book => book.cycleIndex >= startIndex && (!finishedOnly || book.isFinished !== false));
  const volumeReferenceBooks = indexedBooks.filter(book => !finishedOnly || book.isFinished !== false);
  const volume = excludeAbnormallyShortBooks(analyzedBooks, volumeReferenceBooks);
  const chronology = selectChronologicallyConsistentBooks(volume.books);
  const scoredBooks = chronology.books;
  const baseline = scoredBooks[0], last = scoredBooks.at(-1);
  const anomalyDetails = {
    chronologyAdjusted: chronology.excludedBookNumbers.length > 0,
    excludedChronologyBooks: chronology.excludedBookNumbers,
    volumeAdjusted: volume.anomalies.length > 0,
    excludedVolumeBooks: volume.anomalies.map(item => item.bookNumber),
    volumeAnomalies: volume.anomalies,
    adjustedBaseline: Boolean(baseline && baseline.cycleIndex !== analyzedBooks[0]?.cycleIndex),
    originalBaselineBook: analyzedBooks[0]?.cycleIndex + 1 || startIndex + 1
  };
  if (!baseline || scoredBooks.length < MIN_RATING_BOOKS) {
    return {
      value: null, audienceRetention: null, libraryRetention: null, likeRetention: null,
      finaleCommentSpike: null,
      audiencePoints: 0, likePoints: 0,
      audienceMaxPoints: 60, likeMaxPoints: 40,
      baselineComments: baseline?.comments ?? null,
      confidence: 'low', baselineBook: baseline?.cycleIndex + 1 || startIndex + 1,
      lastBook: scoredBooks.at(-1)?.cycleIndex + 1 || null, includedCount: scoredBooks.length,
      minimumBooksRequired: MIN_RATING_BOOKS, insufficientBooks: true, finishedOnly, ...anomalyDetails
    };
  }
  const libraryRetention = ratio(last.libraries, baseline.libraries);
  const audienceRetention = libraryRetention;
  const likeRetention = ratio(last.likes, baseline.likes);
  const exposure = retentionExposure(scoredBooks);
  const modelMode = startIndex > 0 ? 'fromSecond' : 'default';
  const expectedAudienceRetention = expectedRetention('audience', modelMode, exposure);
  const expectedLikeRetention = expectedRetention('likes', modelMode, exposure);
  const audiencePerformance = benchmarkPerformance(audienceRetention, expectedAudienceRetention);
  const likePerformance = benchmarkPerformance(likeRetention, expectedLikeRetention);
  const audienceHalfLife = calculateAudienceHalfLife(scoredBooks, audienceRetention, exposure.durationMonths);
  const baselineComments = isFiniteMetric(baseline.comments) ? Number(baseline.comments) : null;
  const lastComments = isFiniteMetric(last.comments) ? Number(last.comments) : null;
  const finaleCommentSpike = detectFinaleCommentSpike(scoredBooks, { cycleCompleted, totalBookCount: books.length });
  const growthDetected = [audienceRetention, likeRetention].some(value => Number.isFinite(value) && value > 1);
  const earlyVolumesTogether = wereEarlyVolumesPublishedTogether(books);
  const possibleAudienceTransfer = [audienceRetention, likeRetention].some(value => Number.isFinite(value) && value >= TRANSFER_GROWTH_THRESHOLD)
    && earlyVolumesTogether
    && chronology.excludedBookNumbers.length === 0
    && volume.anomalies.length === 0;
  const audienceMaxPoints = 60;
  const likeMaxPoints = 40;
  const signals = [audienceRetention, likeRetention].filter(Number.isFinite);
  const audiencePoints = Number.isFinite(audiencePerformance) ? Math.round(audienceMaxPoints * Math.min(1, audiencePerformance)) : 0;
  const likePoints = Number.isFinite(likePerformance) ? Math.round(likeMaxPoints * Math.min(1, likePerformance)) : 0;
  const metricDetails = {
    audienceRetention,
    libraryRetention,
    likeRetention,
    finaleCommentSpike,
    growthDetected,
    earlyVolumesTogether,
    possibleAudienceTransfer,
    audiencePoints,
    likePoints,
    audienceMaxPoints,
    likeMaxPoints,
    expectedAudienceRetention,
    expectedLikeRetention,
    audiencePerformance,
    likePerformance,
    audienceHalfLife,
    ratingDurationMonths: exposure.durationMonths,
    ratingDurationLabel: exposure.durationLabel,
    medianPublicationGapMonths: exposure.medianGapMonths,
    averagePublicationGapMonths: exposure.averageGapMonths,
    modelMode,
    modelBenchmark: MODEL_BENCHMARK,
    modelSampleSize: modelMode === 'fromSecond' ? 169 : 181,
    modelExtrapolated: exposure.transitions > MODEL_MAX_TRANSITIONS || exposure.durationMonths > MODEL_MAX_DURATION_MONTHS,
    modelDatesComplete: Number.isFinite(exposure.durationMonths),
    dataMaturityMonths: exposure.lastAgeMonths,
    recentTerminalVolume: Number.isFinite(exposure.lastAgeMonths) && exposure.lastAgeMonths < MODEL_MATURITY_MONTHS,
    baselineLibraries: baseline.libraries ?? null,
    lastLibraries: last.libraries ?? null,
    baselineLikes: baseline.likes ?? null,
    lastLikes: last.likes ?? null,
    baselineComments,
    lastComments,
    baselineLikesPer100Libraries: ratePer100(baseline.likes, baseline.libraries),
    lastLikesPer100Libraries: ratePer100(last.likes, last.libraries),
    baselineBook: baseline.cycleIndex + 1,
    lastBook: last.cycleIndex + 1,
    includedCount: scoredBooks.length,
    minimumBooksRequired: MIN_RATING_BOOKS,
    insufficientBooks: false,
    includedBookNumbers: scoredBooks.map(book => book.cycleIndex + 1),
    finishedOnly,
    ...anomalyDetails
  };
  if (!signals.length) return { value: null, ...metricDetails, confidence: 'low' };
  const value = audiencePoints + likePoints;
  return { value, ...metricDetails, confidence: signals.length === 2 ? 'high' : 'low' };
}

function expectedRetention(metric, mode, exposure) {
  const coefficients = RETENTION_MODEL[mode]?.[metric];
  if (!coefficients || !Number.isFinite(exposure.transitions)) return null;
  const transitions = Math.min(MODEL_MAX_TRANSITIONS, Math.max(0, exposure.transitions));
  const durationYears = Number.isFinite(exposure.durationMonths)
    ? Math.min(MODEL_MAX_DURATION_MONTHS, Math.max(0, exposure.durationMonths)) / 12
    : 0;
  return Math.exp(-(coefficients[0] * Math.log1p(transitions) + coefficients[1] * Math.log1p(durationYears)));
}

function benchmarkPerformance(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && expected > 0
    ? Math.max(0, Math.min(1, MODEL_BENCHMARK * actual / expected))
    : null;
}

function retentionExposure(scoredBooks) {
  const firstTime = bookPublicationTimestamp(scoredBooks[0]);
  const lastTime = bookPublicationTimestamp(scoredBooks.at(-1));
  const durationMonths = monthsBetween(firstTime, lastTime);
  const gaps = [];
  for (let index = 1; index < scoredBooks.length; index += 1) {
    const gap = monthsBetween(bookPublicationTimestamp(scoredBooks[index - 1]), bookPublicationTimestamp(scoredBooks[index]));
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  const lastAgeMonths = monthsBetween(lastTime, Date.now());
  return {
    transitions: Math.max(0, scoredBooks.length - 1),
    durationMonths,
    durationLabel: Number.isFinite(durationMonths) ? formatDuration(firstTime, lastTime) : '—',
    medianGapMonths: gaps.length ? median(gaps) : null,
    averageGapMonths: gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null,
    lastAgeMonths
  };
}

function calculateAudienceHalfLife(scoredBooks, terminalRetention, durationMonths) {
  const firstTime = bookPublicationTimestamp(scoredBooks[0]);
  const baselineLibraries = Number(scoredBooks[0]?.libraries);
  if (!Number.isFinite(firstTime) || !Number.isFinite(baselineLibraries) || baselineLibraries <= 0) return { kind: 'unavailable' };
  let previous = { time: firstTime, retention: 1, bookNumber: scoredBooks[0].cycleIndex + 1 };
  for (let index = 1; index < scoredBooks.length; index += 1) {
    const book = scoredBooks[index];
    const time = bookPublicationTimestamp(book);
    const retention = ratio(book.libraries, baselineLibraries);
    if (!Number.isFinite(time) || !Number.isFinite(retention) || time < previous.time) continue;
    if (retention <= 0.5 && previous.retention > 0.5) {
      const denominator = Math.log(retention) - Math.log(previous.retention);
      const fraction = denominator ? (Math.log(0.5) - Math.log(previous.retention)) / denominator : 1;
      const crossingTime = previous.time + Math.max(0, Math.min(1, fraction)) * (time - previous.time);
      return {
        kind: 'observed',
        months: monthsBetween(firstTime, crossingTime),
        bookNumber: book.cycleIndex + 1,
        previousBookNumber: previous.bookNumber
      };
    }
    previous = { time, retention, bookNumber: book.cycleIndex + 1 };
  }
  if (Number.isFinite(terminalRetention) && terminalRetention > 0.5 && terminalRetention < 1
    && Number.isFinite(durationMonths) && durationMonths > 0) {
    return { kind: 'estimated', months: durationMonths * Math.log(0.5) / Math.log(terminalRetention) };
  }
  if (Number.isFinite(terminalRetention) && terminalRetention >= 1) return { kind: 'growth' };
  return { kind: 'unavailable' };
}

function monthsBetween(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? (end - start) / (365.2425 / 12 * 24 * 60 * 60 * 1000)
    : null;
}

function ratePer100(value, base) {
  const measured = ratio(value, base);
  return Number.isFinite(measured) ? measured * 100 : null;
}

function detectFinaleCommentSpike(scoredBooks, { cycleCompleted = false, totalBookCount = scoredBooks.length } = {}) {
  const last = scoredBooks.at(-1);
  if (!cycleCompleted || !last || last.cycleIndex !== totalBookCount - 1) return null;
  const referenceBooks = scoredBooks.slice(0, -1).slice(-FINALE_SPIKE_LOOKBACK);
  const reference = referenceBooks.map(book => {
    const comments = isFiniteMetric(book.comments) ? Number(book.comments) : null;
    const rate = comments === null ? null : ratio(comments * 1000, book.libraries);
    return { bookNumber: book.cycleIndex + 1, comments, rate };
  }).filter(item => Number.isFinite(item.comments) && Number.isFinite(item.rate));
  if (reference.length < FINALE_SPIKE_MIN_REFERENCE_BOOKS) return null;
  const actualComments = isFiniteMetric(last.comments) ? Number(last.comments) : null;
  const actualRate = actualComments === null ? null : ratio(actualComments * 1000, last.libraries);
  if (!Number.isFinite(actualComments) || !Number.isFinite(actualRate)) return null;
  const typicalComments = median(reference.map(item => item.comments));
  const typicalRate = median(reference.map(item => item.rate));
  const commentsRatio = ratio(actualComments, typicalComments);
  const rateRatio = ratio(actualRate, typicalRate);
  if (!Number.isFinite(commentsRatio) || !Number.isFinite(rateRatio)
    || commentsRatio < FINALE_SPIKE_RATIO
    || rateRatio < FINALE_SPIKE_RATIO
    || actualComments - typicalComments < FINALE_SPIKE_MIN_EXCESS_COMMENTS) return null;
  return {
    bookNumber: last.cycleIndex + 1,
    referenceBooks: reference.map(item => item.bookNumber),
    actualComments,
    typicalComments,
    actualRate,
    typicalRate,
    commentsRatio,
    rateRatio,
    excessComments: actualComments - typicalComments
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function excludeAbnormallyShortBooks(books, referenceBooks = books) {
  const measured = referenceBooks
    .map(book => ({ book, textLength: Number(book.textLength) }))
    .filter(item => item.book.isFinished !== false && Number.isFinite(item.textLength) && item.textLength > 0);
  if (measured.length < MIN_VOLUME_SAMPLE_SIZE) return { books, anomalies: [] };
  const lengths = measured.map(item => item.textLength).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  const median = lengths.length % 2 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2;
  const threshold = Math.min(median * SHORT_BOOK_RATIO, SHORT_BOOK_MAX_CHARS);
  const anomalies = measured
    .filter(item => item.textLength < threshold)
    .map(item => ({
      bookNumber: item.book.cycleIndex + 1,
      textLength: item.textLength,
      medianTextLength: Math.round(median),
      ratioToMedian: item.textLength / median
    }));
  const excludedNumbers = new Set(anomalies.map(item => item.bookNumber));
  const kept = books.filter(book => !excludedNumbers.has(book.cycleIndex + 1));
  const relevantAnomalies = anomalies.filter(item => books.some(book => book.cycleIndex + 1 === item.bookNumber));
  return { books: kept, anomalies: relevantAnomalies };
}

function wereEarlyVolumesPublishedTogether(books) {
  const firstTime = bookPublicationTimestamp(books[0]);
  const secondTime = bookPublicationTimestamp(books[1]);
  return Number.isFinite(firstTime) && Number.isFinite(secondTime)
    && Math.abs(secondTime - firstTime) <= EARLY_IMPORT_WINDOW_MS;
}
function selectChronologicallyConsistentBooks(books) {
  const dated = books.map((book, originalIndex) => ({ book, originalIndex, time: bookPublicationTimestamp(book) }))
    .filter(item => Number.isFinite(item.time));
  if (dated.length < 2) return { books, excludedBookNumbers: [] };

  const lengths = new Array(dated.length).fill(1);
  const previous = new Array(dated.length).fill(-1);
  for (let current = 0; current < dated.length; current += 1) {
    for (let before = 0; before < current; before += 1) {
      if (dated[current].time + PUBLICATION_ORDER_TOLERANCE_MS < dated[before].time) continue;
      if (lengths[before] + 1 > lengths[current]) {
        lengths[current] = lengths[before] + 1;
        previous[current] = before;
      }
    }
  }

  let end = 0;
  for (let index = 1; index < dated.length; index += 1) {
    if (lengths[index] >= lengths[end]) end = index;
  }
  const keptOriginalIndices = new Set();
  while (end >= 0) {
    keptOriginalIndices.add(dated[end].originalIndex);
    end = previous[end];
  }
  const datedOriginalIndices = new Set(dated.map(item => item.originalIndex));
  const excludedBookNumbers = books
    .filter((book, index) => datedOriginalIndices.has(index) && !keptOriginalIndices.has(index))
    .map(book => book.cycleIndex + 1);
  return {
    books: books.filter((book, index) => !datedOriginalIndices.has(index) || keptOriginalIndices.has(index)),
    excludedBookNumbers
  };
}
function bookPublicationTimestamp(book) {
  for (const value of [book?.publishedAt, book?.publicationOrderAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return NaN;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}
