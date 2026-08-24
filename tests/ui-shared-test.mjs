import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../shared-ui.js', import.meta.url);
const source = `${fs.readFileSync(sourcePath, 'utf8')}
globalThis.__test = { percent, count, durationMonths, escapeHtml, ratingHint, diagnosticReport, renderLineChart, ratioPercent, absoluteComments };`;

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
const chrome = { runtime: { getManifest: () => ({ version: '0.16.1' }) } };
const context = { document, chrome, Number, Math, Set };
vm.runInNewContext(source, context);

const { percent, count, durationMonths, escapeHtml, ratingHint, diagnosticReport, renderLineChart, ratioPercent, absoluteComments } = context.__test;
assert.equal(percent(.456), '46%');
assert.equal(count(null), '—');
assert.equal(durationMonths(28), '2 года 4 месяца');
assert.equal(durationMonths(.5), 'менее месяца');
assert.equal(escapeHtml('<том> & "цикл"'), '&lt;том&gt; &amp; &quot;цикл&quot;');
assert.equal(ratioPercent(50, 200), 25);
assert.equal(ratioPercent('', 200), null);
assert.equal(absoluteComments({ comments: '120' }), 120);

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
assert.match(diagnosticReport({ title: 'Цикл', author: 'Автор', url: 'https:\/\/example.test', metricVersion: 22 }, score), /AT Cycle Catalog 0\.16\.1/);

const books = [{ title: 'Том 1' }, { title: 'Том 2' }];
const series = [{ label: 'Лайки', color: '#fff', className: 'likes', values: [100, 50], tooltip: () => 'данные' }];
assert.match(renderLineChart('График', books, series, [true, true], [50, 100]), /viewBox="0 0 760 220"/);
assert.match(renderLineChart('График', books, series, [true, true], [50, 100], true), /viewBox="0 0 380 180"/);

console.log('Shared UI tests passed: formatting, hints, reports, and chart layouts work.');
