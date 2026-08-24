import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../background.js', import.meta.url);
const source = `${fs.readFileSync(sourcePath, 'utf8')}\nglobalThis.__test = { parseNumber, parseBookPage, parseCyclePage, calculateCycleDuration, calculateScore, calculateAllScores, fetchWorkDetails, libraryAudienceCount, matchesSearchFilters, scoreForSearch, workMetaToBook, isAudiobook, scanCycle, matchesGenreRules, effectiveGenreRule, normalizeGenreRules, pruneSearchCache, isCycleStale, cleanupStorage, searchCycles, excludeCycle, restoreExcluded, getSearchState, addSearchCycle, getCycleDynamics };`;
const emptyListener = { addListener() {} };
const storageState = {};
const chrome = {
  runtime: { onInstalled: emptyListener, onMessage: emptyListener },
  alarms: { onAlarm: emptyListener, create() {}, async clear() {} },
  tabs: { async create() {}, async remove() {} },
  storage: { local: {
    async get(defaults) { return Array.isArray(defaults) ? Object.fromEntries(defaults.map(key => [key, storageState[key]])) : { ...defaults, ...storageState }; },
    async set(values) { Object.assign(storageState, values); }
  } }
};
const calledApiUrls = [];
const context = { chrome, URL, URLSearchParams, console, setTimeout, clearTimeout, Date, Promise, RegExp, String, Number, Math, Set, Map, fetch: async (url) => {
  calledApiUrls.push(url);
  if (url === 'https://author.today/work/series/42') return { ok: true, status: 200, async text() { return '<h1>Цикл «API-состав»</h1><a href="/work/100">Книга 1</a><a href="/work/200">Книга 2</a>'; } };
  if (url.includes('/v1/catalog/search?')) {
    const page = Number(new URL(url).searchParams.get('page'));
    const firstId = page === 1 ? 1001 : 1026;
    return { ok: true, status: 200, async json() { return {
      searchResults: Array.from({ length: 25 }, (_, index) => {
        const id = firstId + index;
        return { id, seriesId: id, likeCount: 500, genreId: id % 2 === 0 ? 3 : 2 };
      }),
      isLastPage: page >= 2,
      realTotalCount: 50
    }; } };
  }
  if (url.includes('/v1/work/meta-info?')) {
    const ids = [...new URL(url).searchParams.values()].map(Number);
    return { ok: true, status: 200, async json() { return ids.map(id => ({ data: { id, title: `Книга ${id}`, format: id === 300 ? 'Audiobook' : 'EBook', likeCount: 100, commentCount: 100, isFinished: true } })); } };
  }
  if (url.includes('/v1/work/genres')) return { ok: true, status: 200, async json() { return []; } };
  if (url.includes('work-stats')) return { ok: true, status: 200, async json() { return { isSuccessful: true, data: { totalCount: 456 } }; } };
  const workId = Number(/\/work\/(\d+)\/details/.exec(url)?.[1]);
  return { ok: true, status: 200, async json() { return { id: workId, title: `API-книга ${workId}`, format: workId === 300 ? 'Audiobook' : 'EBook', seriesWorkIds: [100, 200, 300], likeCount: 123, commentCount: 104, chapters: [{ publishTime: '2020-01-15T10:00:00Z' }], lastUpdateTime: '2022-07-20T12:00:00Z', isFinished: true }; } };
} };
vm.runInNewContext(source, context);
const { parseNumber, parseBookPage, parseCyclePage, calculateCycleDuration, calculateScore, calculateAllScores, fetchWorkDetails, libraryAudienceCount, matchesSearchFilters, scoreForSearch, workMetaToBook, isAudiobook, scanCycle, matchesGenreRules, effectiveGenreRule, normalizeGenreRules, pruneSearchCache, isCycleStale, cleanupStorage, searchCycles, excludeCycle, restoreExcluded, getSearchState, addSearchCycle, getCycleDynamics } = context.__test;

assert.equal(parseNumber('4,64М'), 4_640_000);
assert.equal(parseNumber('8 771'), 8771);
assert.equal(parseNumber(''), null);

const cycle = parseCyclePage(`
  <h1>Цикл &laquo;Тест&raquo;</h1><a href="/u/test/series">Автор Тестов</a><div>завершен</div>
  <a href="/work/100">Книга 1</a><a href="/work/200">Книга 2</a>
`, 'https://author.today/work/series/42');
assert.equal(cycle.title, 'Тест');
assert.equal(cycle.author, 'Автор Тестов');
assert.equal(cycle.status, 'completed');
assert.deepEqual([...cycle.bookUrls], ['https://author.today/work/100', 'https://author.today/work/200']);
assert.equal(parseCyclePage('<h1>Черновик</h1><div>не завершен</div>', 'https://author.today/work/series/99').status, 'ongoing');
assert.equal(libraryAudienceCount({ totalCount: 4230, readingCount: 1689, savedCount: 246, finishedCount: 2295, dislikedCount: 159 }), 4230);
assert.equal(libraryAudienceCount({ totalCount: 456 }), 456);
assert.equal(libraryAudienceCount({ totalCount: 456, readingCount: null, savedCount: null, finishedCount: null }), 456);

const first = parseBookPage(`<h1>Первая</h1><div class="book-stats"><span data-hint="Просмотры · 4&nbsp;637&nbsp;232"></span><span class="like-count">8 771</span></div><a>Комментарии · 0</a>`, 'https://author.today/work/100');
const last = parseBookPage(`<h1>Последняя</h1><div class="book-stats"><span data-hint="Просмотры · 370&nbsp;485"></span><span class="like-count">2 621</span></div><a>Комментарии · 0</a>`, 'https://author.today/work/200');
assert.equal(first.views, 4_637_232);
assert.equal(first.likes, 8771);
assert.equal(last.likes, 2621);
assert.equal(calculateScore([first, { ...first, likes: 5000 }, last]).likeRetention, 2621 / 8771);
const metricBooks = [
  { likes: 10000, libraries: null, isFinished: true },
  { likes: 5000, libraries: null, isFinished: true },
  { likes: 2500, libraries: null, isFinished: true },
  { likes: 500, libraries: null, isFinished: false }
];
assert.equal(calculateScore(metricBooks, { startIndex: 1 }).likeRetention, 500 / 5000);
assert.equal(calculateScore(metricBooks, { startIndex: 1, finishedOnly: true }).value, null);
assert.equal(calculateScore(metricBooks, { startIndex: 1, finishedOnly: true }).insufficientBooks, true);
assert.equal(calculateScore(metricBooks, { finishedOnly: true }).likeRetention, 2500 / 10000);
const lateSplitBooks = [
  { likes: 11960, libraries: 60285, isFinished: true, publishedAt: '2022-05-21T20:10:51.673Z' },
  { likes: 463, libraries: 1629, isFinished: true, publicationOrderAt: '2026-03-02T07:55:34.930Z' },
  { likes: 6974, libraries: 24066, isFinished: true, publicationOrderAt: '2022-08-05T21:15:36.887Z' },
  { likes: 4050, libraries: 11433, isFinished: true, publicationOrderAt: '2023-09-01T21:15:04.333Z' },
  { likes: 3000, libraries: 9000, isFinished: true, publicationOrderAt: '2024-09-01T21:15:04.333Z' }
];
const correctedLateSplitScore = calculateScore(lateSplitBooks, { startIndex: 1 });
assert.ok(Number.isFinite(correctedLateSplitScore.value));
assert.equal(correctedLateSplitScore.baselineBook, 3);
assert.equal(correctedLateSplitScore.adjustedBaseline, true);
assert.equal(correctedLateSplitScore.chronologyAdjusted, true);
assert.equal(correctedLateSplitScore.earlyVolumesTogether, false);
assert.equal(correctedLateSplitScore.possibleAudienceTransfer, false);
assert.deepEqual([...correctedLateSplitScore.excludedChronologyBooks], [2]);
const correctedDefaultLateSplitScore = calculateScore(lateSplitBooks);
assert.equal(correctedDefaultLateSplitScore.baselineBook, 1);
assert.equal(correctedDefaultLateSplitScore.adjustedBaseline, false);
assert.deepEqual([...correctedDefaultLateSplitScore.excludedChronologyBooks], [2]);
const audienceBooks = [
  { likes: 1000, libraries: 20_000, isFinished: true },
  { likes: 750, libraries: 12_000, isFinished: true },
  { likes: 500, libraries: 8_000, isFinished: true }
];
const audienceScore = calculateScore(audienceBooks);
assert.equal(audienceScore.audienceRetention, 8_000 / 20_000);
assert.equal(audienceScore.baselineLibraries, 20_000);
assert.equal(audienceScore.lastLibraries, 8_000);
assert.ok(audienceScore.value > 0 && audienceScore.value <= 100);
assert.equal(audienceScore.audiencePoints, Math.round(60 * audienceScore.audiencePerformance));
assert.equal(audienceScore.likePoints, Math.round(40 * audienceScore.likePerformance));
assert.equal('popularityPoints' in audienceScore, false);
assert.equal(audienceScore.value, audienceScore.audiencePoints + audienceScore.likePoints);
assert.equal('middleRetention' in audienceScore, false);
const insufficientTwoToms = calculateScore(audienceBooks.slice(0, 2));
assert.equal(insufficientTwoToms.value, null);
assert.equal(insufficientTwoToms.insufficientBooks, true);
assert.equal(insufficientTwoToms.minimumBooksRequired, 3);

function timedRetentionBooks(count, months) {
  const start = Date.parse('2020-01-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const fraction = index / (count - 1);
    return {
      likes: Math.round(10_000 * (1 - .5 * fraction)),
      libraries: Math.round(20_000 * (1 - .6 * fraction)),
      isFinished: true,
      publishedAt: new Date(start + months * fraction * 365.2425 / 12 * 24 * 60 * 60 * 1000).toISOString()
    };
  });
}
const conveyorScore = calculateScore(timedRetentionBooks(8, 2));
const longRunningScore = calculateScore(timedRetentionBooks(8, 24));
assert.equal(conveyorScore.audienceRetention, longRunningScore.audienceRetention);
assert.ok(longRunningScore.value > conveyorScore.value);
assert.ok(longRunningScore.expectedAudienceRetention < conveyorScore.expectedAudienceRetention);
const shortCycleSameRetention = calculateScore(timedRetentionBooks(3, 24));
assert.ok(longRunningScore.value > shortCycleSameRetention.value);
const observedHalfLife = calculateScore([
  { likes: 1000, libraries: 10_000, isFinished: true, publishedAt: '2020-01-01T00:00:00Z' },
  { likes: 700, libraries: 6_000, isFinished: true, publishedAt: '2021-01-01T00:00:00Z' },
  { likes: 500, libraries: 4_000, isFinished: true, publishedAt: '2022-01-01T00:00:00Z' }
]);
assert.equal(observedHalfLife.audienceHalfLife.kind, 'observed');
assert.ok(observedHalfLife.audienceHalfLife.months > 12 && observedHalfLife.audienceHalfLife.months < 24);
const estimatedHalfLife = calculateScore([
  { likes: 1000, libraries: 10_000, isFinished: true, publishedAt: '2020-01-01T00:00:00Z' },
  { likes: 900, libraries: 9_000, isFinished: true, publishedAt: '2020-07-01T00:00:00Z' },
  { likes: 800, libraries: 8_000, isFinished: true, publishedAt: '2021-01-01T00:00:00Z' }
]);
assert.equal(estimatedHalfLife.audienceHalfLife.kind, 'estimated');
assert.ok(estimatedHalfLife.audienceHalfLife.months > 12);
const commentRichScore = calculateScore([
  { likes: 1_000, libraries: 10_000, comments: 200, isFinished: true },
  { likes: 750, libraries: 7_000, comments: 100, isFinished: true },
  { likes: 500, libraries: 5_000, comments: 50, isFinished: true }
]);
assert.equal(commentRichScore.audienceMaxPoints, 60);
assert.equal(commentRichScore.likeMaxPoints, 40);
assert.ok(Number.isFinite(commentRichScore.value));
assert.equal(commentRichScore.value, commentRichScore.audiencePoints + commentRichScore.likePoints);
assert.equal('engagementRetention' in commentRichScore, false);
assert.equal('engagementPoints' in commentRichScore, false);
assert.equal(commentRichScore.baselineComments, 200);
assert.equal(commentRichScore.lastComments, 50);
const lowCommentScore = calculateScore([
  { likes: 1_000, libraries: 10_000, comments: 99, isFinished: true },
  { likes: 750, libraries: 7_000, comments: 70, isFinished: true },
  { likes: 500, libraries: 5_000, comments: 50, isFinished: true }
]);
assert.equal(lowCommentScore.audienceMaxPoints, 60);
assert.equal(lowCommentScore.likeMaxPoints, 40);
assert.equal(lowCommentScore.value, commentRichScore.value);
const finaleSpikeBooks = [
  { likes: 2_000, libraries: 20_000, comments: 900, isFinished: true },
  { likes: 1_500, libraries: 10_000, comments: 600, isFinished: true },
  { likes: 1_300, libraries: 8_000, comments: 500, isFinished: true },
  { likes: 1_200, libraries: 7_500, comments: 450, isFinished: true },
  { likes: 1_100, libraries: 6_500, comments: 400, isFinished: true },
  { likes: 1_000, libraries: 7_000, comments: 1_500, isFinished: true }
];
const rawFinaleScore = calculateScore(finaleSpikeBooks, { startIndex: 1 });
const correctedFinaleScore = calculateScore(finaleSpikeBooks, { startIndex: 1, cycleCompleted: true });
assert.equal(rawFinaleScore.finaleCommentSpike, null);
assert.equal(correctedFinaleScore.finaleCommentSpike.bookNumber, 6);
assert.deepEqual([...correctedFinaleScore.finaleCommentSpike.referenceBooks], [2, 3, 4, 5]);
assert.equal(correctedFinaleScore.finaleCommentSpike.typicalComments, 475);
assert.equal(correctedFinaleScore.value, rawFinaleScore.value);
const migratedAudienceBooks = [
  { likes: 9000, libraries: 59_000, isFinished: true, publishedAt: '2018-03-17T10:00:00Z' },
  { likes: 6000, libraries: 20_000, isFinished: true, publishedAt: '2018-03-17T12:00:00Z' },
  { likes: 7500, libraries: 22_000, isFinished: true, publishedAt: '2021-01-05T10:00:00Z' },
  { likes: 8000, libraries: 23_000, isFinished: true, publishedAt: '2022-01-05T10:00:00Z' }
];
const migratedAudienceScore = calculateScore(migratedAudienceBooks, { startIndex: 1 });
assert.equal(migratedAudienceScore.audienceRetention, 23_000 / 20_000);
assert.equal(migratedAudienceScore.likeRetention, 8000 / 6000);
assert.equal(migratedAudienceScore.value, 100);
assert.equal(migratedAudienceScore.growthDetected, true);
assert.equal(migratedAudienceScore.earlyVolumesTogether, true);
assert.equal(migratedAudienceScore.possibleAudienceTransfer, true);
const conflictingDateScore = calculateScore([
  ...migratedAudienceBooks.slice(0, 2),
  { likes: 7500, libraries: 22_000, isFinished: true, publishedAt: '2023-01-01T10:00:00Z' },
  { likes: 8000, libraries: 23_000, isFinished: true, publishedAt: '2022-01-05T10:00:00Z' },
  { likes: 8500, libraries: 24_000, isFinished: true, publishedAt: '2024-01-05T10:00:00Z' }
], { startIndex: 1 });
assert.equal(conflictingDateScore.growthDetected, true);
assert.equal(conflictingDateScore.earlyVolumesTogether, true);
assert.equal(conflictingDateScore.chronologyAdjusted, true);
assert.equal(conflictingDateScore.possibleAudienceTransfer, false);
const shortMiddleBook = { likes: 5, libraries: 10, isFinished: true };
const longerAudienceScore = calculateScore([audienceBooks[0], shortMiddleBook, ...audienceBooks.slice(1)]);
assert.equal(longerAudienceScore.audienceRetention, audienceScore.audienceRetention);
assert.ok(longerAudienceScore.value >= audienceScore.value);
const volumeAnomalyBooks = [
  { likes: 1000, libraries: 10_000, textLength: 500_000, isFinished: true },
  { likes: 50, libraries: 500, textLength: 50_000, isFinished: true },
  { likes: 800, libraries: 8_000, textLength: 500_000, isFinished: true },
  { likes: 700, libraries: 7_000, textLength: 500_000, isFinished: true }
];
const volumeAdjustedScore = calculateScore(volumeAnomalyBooks);
assert.ok(Number.isFinite(volumeAdjustedScore.value));
assert.equal(volumeAdjustedScore.volumeAdjusted, true);
assert.deepEqual([...volumeAdjustedScore.excludedVolumeBooks], [2]);
assert.equal(volumeAdjustedScore.volumeAnomalies[0].ratioToMedian, 0.1);
assert.equal(volumeAdjustedScore.chronologyAdjusted, false);
const insufficientAfterVolumeExclusion = calculateScore(volumeAnomalyBooks, { startIndex: 1 });
assert.equal(insufficientAfterVolumeExclusion.value, null);
assert.equal(insufficientAfterVolumeExclusion.volumeAdjusted, true);
assert.deepEqual([...insufficientAfterVolumeExclusion.excludedVolumeBooks], [2]);
const realSpinOffLengths = calculateScore([
  { likes: 1000, libraries: 10_000, textLength: 429_628, isFinished: true },
  { likes: 100, libraries: 1_000, textLength: 124_837, isFinished: true },
  { likes: 800, libraries: 8_000, textLength: 435_761, isFinished: true }
]);
assert.equal(realSpinOffLengths.volumeAdjusted, true);
assert.deepEqual([...realSpinOffLengths.excludedVolumeBooks], [2]);
assert.ok(realSpinOffLengths.volumeAnomalies[0].ratioToMedian > 0.2);
assert.ok(realSpinOffLengths.volumeAnomalies[0].ratioToMedian < 0.3);
const unfinishedShortBook = calculateScore([
  { likes: 1000, libraries: 10_000, textLength: 500_000, isFinished: true },
  { likes: 800, libraries: 8_000, textLength: 480_000, isFinished: true },
  { likes: 100, libraries: 1_000, textLength: 10_492, isFinished: false }
]);
assert.equal(unfinishedShortBook.volumeAdjusted, false);
assert.deepEqual([...unfinishedShortBook.excludedVolumeBooks], []);
assert.equal(unfinishedShortBook.lastBook, 3);
const unfinishedShortBookFinishedOnly = calculateScore([
  { likes: 1000, libraries: 10_000, textLength: 500_000, isFinished: true },
  { likes: 800, libraries: 8_000, textLength: 480_000, isFinished: true },
  { likes: 100, libraries: 1_000, textLength: 10_492, isFinished: false }
], { finishedOnly: true });
assert.equal(unfinishedShortBookFinishedOnly.lastBook, 2);
assert.equal(calculateCycleDuration([
  { publishedAt: '2020-01-01T00:00:00Z' },
  { lastUpdatedAt: '2022-07-01T00:00:00Z' }
]).durationLabel, '2 года 6 месяцев');
assert.equal(calculateCycleDuration([
  { publishedAt: '2024-01-01T00:00:00Z' },
  { lastUpdatedAt: '2024-01-20T00:00:00Z' }
]).durationLabel, 'менее месяца');
assert.equal(calculateCycleDuration([
  { publishedAt: '2019-02-12T19:06:04.367Z' },
  { lastUpdatedAt: '2026-08-17T17:56:40.523Z' }
]).durationLabel, '7 лет 6 месяцев');
const apiBook = await fetchWorkDetails('https://author.today/work/100');
assert.deepEqual(calledApiUrls, [
  'https://api.author.today/v1/work/100/details',
  'https://author.today/work/work-stats?workId=100'
]);
assert.equal(apiBook.likes, 123);
assert.equal(apiBook.libraries, 456);
assert.equal(apiBook.publishedAt, '2020-01-15T10:00:00Z');
assert.equal(apiBook.lastUpdatedAt, '2022-07-20T12:00:00Z');
assert.equal(isAudiobook({ format: 'Audiobook' }), true);
assert.equal(isAudiobook({ format: 'EBook' }), false);
const scannedCycle = await scanCycle('https://author.today/work/series/42');
assert.deepEqual([...scannedCycle.bookUrls], ['https://author.today/work/100', 'https://author.today/work/200']);
assert.equal(scannedCycle.books.length, 2);
assert.equal(scannedCycle.books.some(book => book.format === 'Audiobook'), false);

const searchCycle = {
  status: 'completed', durationYears: 2.5,
  score: audienceScore,
  scores: { default: audienceScore, fromSecond: { ...audienceScore, value: 55 } }
};
assert.equal(scoreForSearch(searchCycle, { fromSecond: true, finishedOnly: false }).value, 55);
searchCycle.books = [{ likes: 1000 }, { likes: 500 }, { likes: 250 }];
assert.equal(matchesSearchFilters(searchCycle, { status: 'completed', minScore: '39', minAudienceRetention: '34', minLikeRetention: '39', minBookLikes: '900', minBooks: '2' }), true);
assert.equal(matchesSearchFilters(searchCycle, { status: 'completed', minScore: '', minAudienceRetention: '', minLikeRetention: '', minBookLikes: '1100', minBooks: '' }), false);
assert.equal(matchesSearchFilters(searchCycle, { status: 'completed', minScore: '', minAudienceRetention: '', minLikeRetention: '', minBookLikes: '', minBooks: '4' }), false);
assert.equal(matchesSearchFilters(searchCycle, { status: 'completed', minScore: '', minAudienceRetention: '', minLikeRetention: '', minBookLikes: '', minBooks: '3' }), false);
assert.equal(matchesSearchFilters(searchCycle, { status: 'ongoing', minScore: '', minAudienceRetention: '', minLikeRetention: '', minBooks: '' }), false);
const metaBook = workMetaToBook({ id: 77, title: 'Мета-книга', format: 'EBook', likeCount: 9, isFinished: true, genreId: 1, firstSubGenreId: 2, secondSubGenreId: 3 });
assert.equal(metaBook.url, 'https://author.today/work/77');
assert.deepEqual([...metaBook.genreIds], [1, 2, 3]);
assert.equal(metaBook.format, 'EBook');

const genreCatalog = [
  { id: 1, parentId: null, title: 'Фэнтези' },
  { id: 2, parentId: 1, title: 'Боевое фэнтези' },
  { id: 3, parentId: 1, title: 'Городское фэнтези' },
  { id: 4, parentId: null, title: 'Фантастика' }
];
const adaptiveRules = { 1: 'include', 2: 'exclude' };
assert.equal(matchesGenreRules({ genreId: 3 }, adaptiveRules, genreCatalog), true);
assert.equal(matchesGenreRules({ genreId: 2 }, adaptiveRules, genreCatalog), false);
assert.equal(matchesGenreRules({ genreId: 4 }, adaptiveRules, genreCatalog), false);
assert.equal(matchesGenreRules({ genreId: 3, firstSubGenreId: 2 }, adaptiveRules, genreCatalog), false);
assert.equal(matchesGenreRules({ genreId: 3 }, { 2: 'exclude' }, genreCatalog), true);
assert.equal(matchesGenreRules({ genreId: 2 }, { 2: 'exclude' }, genreCatalog), false);
assert.equal(effectiveGenreRule(3, { 1: 'include' }, new Map(genreCatalog.map(genre => [genre.id, genre]))), 'include');
assert.equal(effectiveGenreRule(3, { 1: 'include', 3: 'neutral' }, new Map(genreCatalog.map(genre => [genre.id, genre]))), null);
assert.equal(matchesGenreRules({ genreId: 3 }, { 1: 'include', 3: 'neutral' }, genreCatalog), false);
assert.equal(matchesGenreRules({ genreId: 1, firstSubGenreId: 3 }, { 1: 'include', 3: 'neutral' }, genreCatalog), false);
assert.equal(matchesGenreRules({ genreId: 1 }, { 1: 'include', 3: 'neutral' }, genreCatalog), true);
assert.equal(matchesGenreRules({ genreId: 4, firstSubGenreId: 3 }, { 4: 'exclude' }, genreCatalog), false);
assert.deepEqual({ ...normalizeGenreRules({ 1: 'include', 2: 'bad', 3: 'neutral', nope: 'exclude' }) }, { 1: 'include', 3: 'neutral' });

storageState.searchCache = Object.fromEntries(Array.from({ length: 50 }, (_, index) => {
  const id = 1001 + index;
  const value = id % 2 === 0 ? 50 : 10;
  return [id, { cachedAt: new Date().toISOString(), cycle: {
    seriesId: id,
    url: `https://author.today/work/series/${id}`,
    title: `Цикл ${id}`,
    author: 'Автор',
    status: 'completed',
    books: [{ likes: 500 }, { likes: 300 }, { likes: 200 }],
    score: { value },
    scores: { default: { value } },
    metricVersion: 22
  } }];
}));
storageState.excludedCycles = [];
storageState.pausedUntil = 0;
storageState.genreCatalog = { genres: genreCatalog, cachedAt: new Date().toISOString() };
const searchBatch = await searchCycles({ status: 'all', sorting: 'popular', minScore: '40', minBooks: '2', genreRules: adaptiveRules }, { page: 1, offset: 0 });
assert.equal(searchBatch.results.length, 10);
assert.equal(searchBatch.checked, 10);
assert.equal(searchBatch.cursor.page, 1);
assert.equal(searchBatch.cursor.offset, 20);
assert.equal(searchBatch.isLastPage, false);

const dynamicsCycle = {
  seriesId: 77,
  url: 'https://author.today/work/series/77',
  title: 'Динамика',
  author: 'Автор',
  status: 'completed',
  books: [
    { url: 'https://author.today/work/100', likes: 1_000, comments: 200, libraries: null, isFinished: true },
    { url: 'https://author.today/work/200', likes: 500, comments: 100, libraries: null, isFinished: true },
    { url: 'https://author.today/work/300', likes: 250, comments: 50, libraries: null, isFinished: true }
  ],
  scores: calculateAllScores([]),
  score: { value: null },
  metricVersion: 22,
  updatedAt: new Date().toISOString()
};
storageState.searchCache = { 77: { cachedAt: new Date().toISOString(), cycle: dynamicsCycle } };
storageState.cycles = [];
const workStatsCallsBefore = calledApiUrls.filter(url => url.includes('work-stats')).length;
const dynamics = await getCycleDynamics(77);
assert.equal(dynamics.status, 'ready');
assert.deepEqual(dynamics.cycle.books.map(book => book.libraries), [456, 456, 456]);
assert.equal(dynamics.cycle.scores.default.baselineComments, 200);
assert.equal(dynamics.cycle.scores.default.lastComments, 50);
assert.ok(Number.isFinite(dynamics.cycle.scores.default.value));
const workStatsCallsAfter = calledApiUrls.filter(url => url.includes('work-stats')).length;
assert.equal(workStatsCallsAfter - workStatsCallsBefore, 3);
await getCycleDynamics(77);
assert.equal(calledApiUrls.filter(url => url.includes('work-stats')).length, workStatsCallsAfter);

await excludeCycle({ seriesId: 42, title: 'Скрытый цикл', author: 'Автор' }, 'ignored');
assert.equal((await getSearchState()).excludedCycles[0].reason, 'ignored');
await restoreExcluded(42);
assert.equal((await getSearchState()).excludedCycles.length, 0);
storageState.searchCache = { 42: { cachedAt: new Date().toISOString(), cycle: { seriesId: 42, url: 'https://author.today/work/series/42', books: [], score: { value: 1 }, metricVersion: 22, updatedAt: new Date().toISOString() } } };
storageState.cycles = [];
storageState.queue = [];
assert.equal((await addSearchCycle(42)).added, true);
assert.equal((await addSearchCycle(42)).reason, 'exists');

const cleanupNow = Date.now();
const freshCacheEntry = { cachedAt: new Date(cleanupNow - 60_000).toISOString(), cycle: { seriesId: 1, metricVersion: 22 } };
const expiredCacheEntry = { cachedAt: new Date(cleanupNow - 2 * 24 * 60 * 60 * 1000).toISOString(), cycle: { seriesId: 2, metricVersion: 22 } };
const obsoleteMetricEntry = { cachedAt: new Date(cleanupNow - 60_000).toISOString(), cycle: { seriesId: 3, metricVersion: 20 } };
assert.deepEqual(Object.keys(pruneSearchCache({ 1: freshCacheEntry, 2: expiredCacheEntry, 3: obsoleteMetricEntry }, cleanupNow)), ['1']);
assert.equal(isCycleStale({ metricVersion: 22, score: { value: 5 }, updatedAt: new Date(cleanupNow - 60_000).toISOString() }, cleanupNow), false);
assert.equal(isCycleStale({ metricVersion: 22, score: { value: 5 }, updatedAt: new Date(cleanupNow - 2 * 24 * 60 * 60 * 1000).toISOString() }, cleanupNow), true);
storageState.searchCache = { 1: freshCacheEntry, 2: expiredCacheEntry, 3: obsoleteMetricEntry };
storageState.genreCatalog = { genres: genreCatalog, cachedAt: new Date(cleanupNow - 2 * 24 * 60 * 60 * 1000).toISOString() };
storageState.pausedUntil = cleanupNow - 1;
storageState.queue = ['https://author.today/work/series/7', 'https://author.today/work/series/7', 'bad'];
storageState.excludedCycles = [{ seriesId: 9, title: 'Первый' }, { seriesId: 9, title: 'Дубль' }];
await cleanupStorage();
assert.deepEqual([...storageState.queue], ['https://author.today/work/series/7']);
assert.equal(storageState.pausedUntil, 0);
assert.equal(storageState.excludedCycles.length, 1);
assert.deepEqual(Object.keys(storageState.searchCache), ['1']);
assert.equal(storageState.genreCatalog, null);

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const consentSource = fs.readFileSync(new URL('../consent.js', import.meta.url), 'utf8');
const contentSource = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
assert.equal(manifest.version, '0.16.1');
assert.match(consentSource, />Принять</);
assert.match(consentSource, />Отклонить</);
assert.match(consentSource, /privacyConsent/);
assert.match(contentSource, /privacyConsent\?\.version !== 1/);
for (const page of ['current', 'popup', 'search']) {
  const html = fs.readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
  const pageSource = fs.readFileSync(new URL(`../${page}.js`, import.meta.url), 'utf8');
  assert.ok(html.indexOf('shared-ui.js') < html.indexOf(`${page}.js`), `${page}.html must load shared-ui.js first`);
  assert.match(pageSource, /if \(accepted\)/, `${page}.js must not start after declined consent`);
}
assert.match(fs.readFileSync(new URL('../current.html', import.meta.url), 'utf8'), /width:\s*560px;\s*min-height:\s*560px/);

console.log('Smoke tests passed: privacy consent, parsing, 3-tom minimum, time/book-adjusted 60/40 rating, half-life, reference comments, adaptive genres, filters and 10-card search batches work.');
