import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const input = path.resolve(options.input || path.join(root, '.calibration-data', 'cycles.ndjson'));
const output = path.resolve(options.output || path.join(path.dirname(input), 'model-report.json'));
const scoreSet = options.scoreSet === 'finished' ? 'finished' : 'all';
const maturityMonths = nonNegativeNumber(options.maturity, 6);
const cycles = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const oldModel = {
  default: { audience: [0.8172999268, 0.3662175648], likes: [0.5431390050, 0.1985022680] },
  fromSecond: { audience: [0.3141115798, 0.4347971684], likes: [0.2887959611, 0.2344276046] }
};
const report = {
  generatedAt: new Date().toISOString(),
  cycleCount: cycles.length,
  cohortCounts: Object.fromEntries(Object.entries(groupCounts(cycles, item => item.calibrationEligibility?.type || item.status || 'unknown'))),
  scoreSet,
  maturityMonths,
  formula: 'retention = exp(-a * ln(1 + transitions) - b * ln(1 + years))',
  models: {}
};

for (const mode of ['default', 'fromSecond']) {
  report.models[mode] = {};
  for (const metric of ['audience', 'likes']) {
    const observations = buildObservations(cycles, mode, metric, { scoreSet, maturityMonths });
    if (observations.length < 3) {
      report.models[mode][metric] = {
        observations: observations.length,
        uniqueCycles: new Set(observations.map(item => item.group)).size,
        status: 'insufficient-sample'
      };
      continue;
    }
    const coefficients = fitHuber(observations);
    const crossValidation = groupedCrossValidation(observations, 5);
    const oldCoefficients = oldModel[mode][metric];
    const oldMae = mean(observations.map(item => Math.abs(item.y - predict(item, oldCoefficients))));
    const newMae = mean(observations.map(item => Math.abs(item.y - predict(item, coefficients))));
    const intervals = bootstrapIntervals(observations, 400);
    report.models[mode][metric] = {
      observations: observations.length,
      uniqueCycles: new Set(observations.map(item => item.group)).size,
      coefficients: { transitions: coefficients[0], years: coefficients[1] },
      bootstrap95: {
        transitions: [intervals.a[0], intervals.a[1]],
        years: [intervals.b[0], intervals.b[1]]
      },
      mae: { oldModel: oldMae, fittedFullSample: newMae, groupedCv: crossValidation.mae },
      groupedCvFolds: crossValidation.folds,
      oldCoefficients: { transitions: oldCoefficients[0], years: oldCoefficients[1] }
    };
  }
}

fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
const markdownPath = output.replace(/\.json$/i, '.md');
fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
console.log('Отчёт: ' + output);
console.log(renderMarkdown(report));

function buildObservations(items, mode, metric, settings) {
  const scoreKey = settings.scoreSet === 'finished'
    ? (mode === 'default' ? 'finished' : 'finishedFromSecond')
    : (mode === 'default' ? 'default' : 'fromSecond');
  const retentionKey = metric === 'audience' ? 'audienceRetention' : 'likeRetention';
  return items.flatMap(cycle => {
    const score = cycle.scores?.[scoreKey];
    const retention = Number(score?.[retentionKey]);
    const durationMonths = Number(score?.ratingDurationMonths);
    const transitions = Number(score?.includedCount) - 1;
    const dataMaturityMonths = Number(score?.dataMaturityMonths);
    const mature = Number.isFinite(dataMaturityMonths) && dataMaturityMonths >= settings.maturityMonths;
    if (!mature || !Number.isFinite(retention) || retention <= 0 || retention > 1
      || !Number.isFinite(durationMonths) || durationMonths < 0 || !Number.isFinite(transitions) || transitions < 1) return [];
    return [{
      group: Number(cycle.seriesId),
      x: [Math.log1p(transitions), Math.log1p(durationMonths / 12)],
      y: -Math.log(retention)
    }];
  });
}

function fitHuber(observations, epsilon = 1.35) {
  if (observations.length < 3) return [0, 0];
  let coefficients = weightedLeastSquares(observations, observations.map(() => 1));
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const residuals = observations.map(item => item.y - predict(item, coefficients));
    const center = median(residuals);
    const scale = Math.max(1e-9, median(residuals.map(value => Math.abs(value - center))) / 0.67448975);
    const cutoff = epsilon * scale;
    const weights = residuals.map(value => Math.abs(value - center) <= cutoff ? 1 : cutoff / Math.abs(value - center));
    const next = weightedLeastSquares(observations, weights);
    if (Math.hypot(next[0] - coefficients[0], next[1] - coefficients[1]) < 1e-10) return next;
    coefficients = next;
  }
  return coefficients;
}

function weightedLeastSquares(observations, weights) {
  let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const [x, y] = observations[index].x;
    const z = observations[index].y;
    const w = weights[index];
    xx += w * x * x; xy += w * x * y; yy += w * y * y;
    xz += w * x * z; yz += w * y * z;
  }
  const determinant = xx * yy - xy * xy;
  if (Math.abs(determinant) < 1e-12) return [0, 0];
  return [
    Math.max(0, (xz * yy - yz * xy) / determinant),
    Math.max(0, (yz * xx - xz * xy) / determinant)
  ];
}

function groupedCrossValidation(observations, foldCount) {
  const foldErrors = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const test = observations.filter(item => stableFold(item.group, foldCount) === fold);
    const train = observations.filter(item => stableFold(item.group, foldCount) !== fold);
    if (!test.length || train.length < 3) continue;
    const coefficients = fitHuber(train);
    foldErrors.push({
      fold: fold + 1,
      train: train.length,
      test: test.length,
      mae: mean(test.map(item => Math.abs(item.y - predict(item, coefficients))))
    });
  }
  return { mae: mean(foldErrors.map(item => item.mae)), folds: foldErrors };
}

function bootstrapIntervals(observations, iterations) {
  const groups = [...new Set(observations.map(item => item.group))];
  let state = 0x9e3779b9;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const a = [], b = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const chosen = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]);
    const sample = chosen.flatMap(group => observations.filter(item => item.group === group));
    const coefficients = fitHuber(sample);
    a.push(coefficients[0]);
    b.push(coefficients[1]);
  }
  a.sort((left, right) => left - right);
  b.sort((left, right) => left - right);
  return { a: [quantile(a, .025), quantile(a, .975)], b: [quantile(b, .025), quantile(b, .975)] };
}

function predict(observation, coefficients) {
  return observation.x[0] * coefficients[0] + observation.x[1] * coefficients[1];
}

function stableFold(value, count) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function renderMarkdown(value) {
  const lines = [
    '# Калибровка модели удержания',
    '',
    'Циклов после базовой очистки: ' + value.cycleCount + '.',
    'Набор оценок: ' + value.scoreSet + '; минимальная зрелость последнего тома: ' + value.maturityMonths + ' мес.',
    '',
    '| Режим | Метрика | N | a: переходы | b: время | CV MAE | MAE старой модели |',
    '|---|---:|---:|---:|---:|---:|---:|'
  ];
  for (const [mode, metrics] of Object.entries(value.models)) {
    for (const [metric, model] of Object.entries(metrics)) {
      if (model.status === 'insufficient-sample') {
        lines.push('| ' + mode + ' | ' + metric + ' | ' + model.observations + ' | — | — | — | — |');
        continue;
      }
      lines.push('| ' + mode + ' | ' + metric + ' | ' + model.observations + ' | '
        + model.coefficients.transitions.toFixed(6) + ' | ' + model.coefficients.years.toFixed(6) + ' | '
        + formatNumber(model.mae.groupedCv, 4) + ' | ' + formatNumber(model.mae.oldModel, 4) + ' |');
    }
  }
  return lines.join('\n') + '\n';
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
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

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function groupCounts(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = String(selector(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
