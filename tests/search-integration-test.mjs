import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../background.js', import.meta.url);
const source = `${fs.readFileSync(sourcePath, 'utf8')}\nglobalThis.__searchTest = { analyzeCatalogCandidate, fetchApiWorkDetails, fetchSeriesMeta, getGenreCatalog, matchesGenreRules, resolveCyclePage };`;
const listener = { addListener() {} };
const chrome = {
  runtime: { onInstalled: listener, onMessage: listener },
  alarms: { onAlarm: listener, create() {}, async clear() {} },
  storage: { local: { async get() { return {}; }, async set() {} } }
};
const context = { chrome, fetch, URL, URLSearchParams, console, setTimeout, clearTimeout, Date, Promise, RegExp, String, Number, Math, Set, Map };
vm.runInNewContext(source, context);

const genres = await context.__searchTest.getGenreCatalog();
const fantasy = genres.find(genre => genre.title === 'Фэнтези');
const combatFantasy = genres.find(genre => genre.title === 'Боевое фэнтези');
const urbanFantasy = genres.find(genre => genre.title === 'Городское фэнтези');
assert.ok(fantasy && combatFantasy && urbanFantasy);
assert.equal(combatFantasy.parentId, fantasy.id);
const adaptiveGenreRules = { [fantasy.id]: 'include', [combatFantasy.id]: 'exclude' };
assert.equal(context.__searchTest.matchesGenreRules({ genreId: urbanFantasy.id }, adaptiveGenreRules, genres), true);
assert.equal(context.__searchTest.matchesGenreRules({ genreId: combatFantasy.id }, adaptiveGenreRules, genres), false);

const resolvedFromBook = await context.__searchTest.resolveCyclePage('https://author.today/work/456782', { cycles: [], searchCache: {} });
assert.equal(resolvedFromBook.status, 'ready');
assert.equal(resolvedFromBook.seriesId, 28510);
assert.equal(resolvedFromBook.url, 'https://author.today/work/series/28510');

const firstRaw = await context.__searchTest.fetchApiWorkDetails(28530);
const metaItems = await context.__searchTest.fetchSeriesMeta(firstRaw.seriesWorkIds);
assert.equal(metaItems.length, firstRaw.seriesWorkIds.length);
const cycle = await context.__searchTest.analyzeCatalogCandidate({
  id: 28530,
  seriesId: 5008,
  seriesTitle: 'Путь',
  authorFIO: 'Михаил Игнатов'
}, genres);

assert.equal(cycle.seriesId, 5008);
assert.equal(cycle.title, 'Путь');
assert.ok(cycle.books.length >= 3);
assert.ok(Number.isFinite(cycle.scores.default.value));
assert.ok(Number.isFinite(cycle.scores.default.audienceRetention));
assert.ok(Number.isFinite(cycle.scores.default.expectedAudienceRetention));
assert.equal(cycle.scores.default.modelDatesComplete, true);
assert.ok(['observed', 'estimated', 'growth'].includes(cycle.scores.default.audienceHalfLife.kind));
assert.notEqual(cycle.durationLabel, '—');
assert.ok(cycle.genres.length > 0 && cycle.genres.length <= 3);
assert.equal(cycle.books.length, 22);
assert.equal(cycle.books[21].isFinished, false);
assert.equal(cycle.scores.default.excludedVolumeBooks.includes(22), false);
assert.equal(cycle.scores.default.lastBook, 22);
assert.equal(cycle.scores.finished.lastBook, 21);

// Every excluded genre assigned to the first book must reject the whole cycle.
// Hidden Legion book 1 currently has RealRPG (69), Post-apocalypse (32), and
// Combat science fiction (30), which belong to more than one catalog branch.
const hiddenLegion = await context.__searchTest.fetchApiWorkDetails(33419);
assert.deepEqual([hiddenLegion.genreId, hiddenLegion.firstSubGenreId, hiddenLegion.secondSubGenreId], [69, 32, 30]);
for (const genreId of [69, 32, 30]) {
  assert.equal(context.__searchTest.matchesGenreRules(hiddenLegion, { [genreId]: 'exclude' }, genres), false);
}

const coldFlameCycle = await context.__searchTest.analyzeCatalogCandidate({
  id: 131901,
  seriesId: 14008,
  seriesTitle: 'Холодное пламя',
  authorFIO: 'Алексей Осадчук'
}, genres);
assert.equal(coldFlameCycle.books.length, 5);
assert.equal(coldFlameCycle.books.some(book => book.format === 'Audiobook'), false);
assert.deepEqual([...coldFlameCycle.books.map(book => Number(/\/work\/(\d+)/.exec(book.url)?.[1]))], [131901, 135702, 143344, 152889, 161990]);

const tensionCycle = await context.__searchTest.analyzeCatalogCandidate({
  id: 14846,
  seriesId: 1463,
  seriesTitle: 'Напряжение',
  authorFIO: 'Владимир Ильин'
});
assert.equal(tensionCycle.scores.fromSecond.value, 100);
assert.ok(tensionCycle.scores.fromSecond.audienceRetention > 1.1);
assert.ok(tensionCycle.scores.fromSecond.likeRetention > 1.25);
assert.equal(tensionCycle.scores.fromSecond.growthDetected, true);
assert.equal(tensionCycle.scores.fromSecond.possibleAudienceTransfer, true);

const anomalyCycle = await context.__searchTest.analyzeCatalogCandidate({
  id: 157349,
  seriesId: 21558,
  seriesTitle: 'Романов',
  authorFIO: 'Владимир Кощеев'
});
assert.equal(anomalyCycle.books.length, 16);
assert.equal(anomalyCycle.scores.fromSecond.baselineBook, 3);
assert.equal(anomalyCycle.scores.fromSecond.chronologyAdjusted, true);
assert.deepEqual([...anomalyCycle.scores.fromSecond.excludedChronologyBooks], [2]);
assert.equal(anomalyCycle.scores.fromSecond.value, anomalyCycle.scores.fromSecond.audiencePoints + anomalyCycle.scores.fromSecond.likePoints);
assert.equal('engagementPoints' in anomalyCycle.scores.fromSecond, false);

const chekhovCycle = await context.__searchTest.analyzeCatalogCandidate({
  id: 280000,
  seriesId: 28510,
  seriesTitle: 'Чехов',
  authorFIO: 'Сергей Карелин'
}, genres);
const chekhovScore = chekhovCycle.scores.fromSecond;
assert.equal(chekhovCycle.books.length, 15);
assert.equal(chekhovScore.finaleCommentSpike.bookNumber, 15);
assert.deepEqual([...chekhovScore.finaleCommentSpike.referenceBooks], [11, 12, 13, 14]);
assert.ok(chekhovScore.finaleCommentSpike.commentsRatio > 3);
assert.ok(chekhovScore.finaleCommentSpike.rateRatio > 3);
assert.equal(chekhovScore.value, chekhovScore.audiencePoints + chekhovScore.likePoints);
assert.equal('engagementRetention' in chekhovScore, false);

console.log(`Search integration passed: adaptive genres; ${cycle.title}; ${coldFlameCycle.title}: 5 ebooks, audio excluded; transfer marker: ${tensionCycle.title}; anomaly correction: ${anomalyCycle.title}, book 2 excluded, score ${anomalyCycle.scores.fromSecond.value}; finale discussion marker: ${chekhovCycle.title}, ratio ${Math.round(chekhovScore.finaleCommentSpike.commentsRatio * 100)}%.`);
