import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../shared-ui.js', import.meta.url);
const source = `${fs.readFileSync(sourcePath, 'utf8')}
globalThis.__test = { percent, count, durationMonths, escapeHtml, ratingHint, diagnosticReport, renderLineChart, ratioPercent, absoluteComments, metricDelta, benchmarkComparison, weightedBenchmarkRatio, openExtensionPage };`;

const document = {
  createElement() {
    let text = '';
    return {
      set textContent(value) { text = String(value ?? ''); },
      get innerHTML() {
        return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      }
    };
  }
};
let createdTab = null;
let matchedTab = null;
let updatedTab = null;
let reloadedTabId = null;
const chrome = {
  runtime: { getManifest: () => ({ version: '0.18.4' }), getURL: path => `chrome-extension://test/${path}` },
  tabs: {
    async query(options) { return options.url ? (matchedTab ? [matchedTab] : []) : [{ windowId: 17 }]; },
    async create(options) { createdTab = options; return options; },
    async reload(id) { reloadedTabId = id; },
    async update(id, options) { updatedTab = { id, ...options }; return updatedTab; }
  }
};
const context = { document, chrome, Number, Math, Set };
vm.runInNewContext(source, context);

const { percent, count, durationMonths, escapeHtml, ratingHint, diagnosticReport, renderLineChart, ratioPercent, absoluteComments, metricDelta, benchmarkComparison, weightedBenchmarkRatio, openExtensionPage } = context.__test;
assert.equal(percent(.456), '46%');
assert.equal(count(null), '—');
assert.equal(durationMonths(28), '2 года 4 месяца');
assert.equal(durationMonths(.5), 'менее месяца');
assert.equal(escapeHtml('<том> & "цикл"'), '&lt;том&gt; &amp; &quot;цикл&quot;');
assert.equal(ratioPercent(50, 200), 25);
assert.equal(ratioPercent('', 200), null);
assert.equal(absoluteComments({ comments: '120' }), 120);
assert.equal(metricDelta(750, 1000), '\nК предыдущему тому: −25% (−250)');
assert.equal(benchmarkComparison(1), 'Удержание: на уровне среднего');
assert.equal(benchmarkComparison(2.34), 'Удержание: +134% к среднему');
assert.equal(benchmarkComparison(.72), 'Удержание: −28% к среднему');
assert.equal(weightedBenchmarkRatio(2, 1), 1.6);
await openExtensionPage('popup.html');
assert.equal(createdTab.url, 'chrome-extension://test/popup.html');
assert.equal(createdTab.windowId, 17);
matchedTab = { id: 42, windowId: 18 };
createdTab = null;
await openExtensionPage('popup.html');
assert.equal(createdTab, null);
assert.equal(reloadedTabId, 42);
assert.deepEqual(JSON.parse(JSON.stringify(updatedTab)), { id: 42, active: true });

const score = {
  value: 50,
  audiencePoints: 30,
  likePoints: 20,
  audienceRetention: .5,
  likeRetention: .4,
  expectedAudienceRetention: .5,
  expectedLikeRetention: .4,
  baselineBook: 1,
  lastBook: 3,
  includedCount: 3,
  includedBookNumbers: [1, 2, 3]
};
assert.match(ratingHint(score), /Аудитория: 30 из 60 баллов/);
assert.match(diagnosticReport({ title: 'Цикл', author: 'Автор', url: 'https:\/\/example.test', metricVersion: 23 }, score), /AT Cycle Catalog 0\.18\.4/);

const books = [{ title: 'Том 1' }, { title: 'Том 2' }];
const series = [{ label: 'Лайки', color: '#fff', className: 'likes', values: [100, 50], tooltip: () => 'данные' }];
assert.match(renderLineChart('График', books, series, [true, true], [50, 100]), /viewBox="0 0 760 220"/);
assert.match(renderLineChart('График', books, series, [true, true], [50, 100], true), /viewBox="0 0 380 180"/);

console.log('Shared UI tests passed: formatting, hints, reports, and chart layouts work.');
