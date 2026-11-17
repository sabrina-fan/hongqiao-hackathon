import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const apiKey = process.env.JEV_API_KEY;
const baseUrl = process.env.JEV_BASE_URL;
const model = process.env.JEV_MODEL ?? 'jev-latest';
const timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 15000);
if (!apiKey || !baseUrl) throw new Error('JEV_BASE_URL and JEV_API_KEY are required');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
  throw new Error('JEV_TIMEOUT_MS must be between 1 and 60000');
}
const base = new URL(baseUrl);
if (
  base.protocol !== 'https:' ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== '/'
) {
  throw new Error(
    'JEV_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment',
  );
}

function redact(value) {
  return String(value)
    .replaceAll(apiKey, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

function errorSummary(data) {
  const error = data?.error;
  return {
    code: redact(error?.code ?? data?.code ?? ''),
    message: redact(error?.message ?? (typeof error === 'string' ? error : (data?.message ?? ''))),
  };
}

async function request(path, payload) {
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('Cross-origin requests are forbidden');
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: payload === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return {
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      contentType: response.headers.get('content-type'),
      data,
    };
  } catch (error) {
    return {
      status: null,
      elapsedMs: Math.round(performance.now() - started),
      error: redact(error.message),
    };
  }
}

function summarize(result) {
  return {
    status: result.status,
    elapsedMs: result.elapsedMs,
    contentType: result.contentType,
    error: result.error,
    ...(result.data ? { upstreamError: errorSummary(result.data) } : {}),
  };
}

function validateAnswer(question, answer) {
  const issues = [];
  if (!answer || typeof answer !== 'object') return ['answer missing'];
  if (answer.type !== question.type) issues.push('answer type mismatch');
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    issues.push('confidence outside [0,1]');
  }
  const options =
    question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
  const probabilities = answer.probabilities;
  const keys = probabilities && typeof probabilities === 'object' ? Object.keys(probabilities) : [];
  if (keys.length !== options.length || !options.every((key) => keys.includes(key))) {
    issues.push('probability keys differ from allowed options');
  }
  if (
    keys.some(
      (key) =>
        !Number.isFinite(probabilities[key]) || probabilities[key] < 0 || probabilities[key] > 1,
    )
  ) {
    issues.push('invalid probability');
  }
  const sum = keys.reduce((total, key) => total + probabilities[key], 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.001)
    issues.push('probabilities do not sum to one');
  if (question.type === 'choice') {
    if (!options.includes(answer.choice)) issues.push('choice outside allowed set');
  } else {
    if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > options.length - 1) {
      issues.push('score outside rubric range');
    }
    const mean = keys.reduce((total, key) => total + Number(key) * probabilities[key], 0);
    if (!Number.isFinite(mean) || Math.abs(mean - answer.score) > 0.001) {
      issues.push('score differs from probability-weighted level mean');
    }
  }
  return issues;
}

function latencySummary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

function redactTree(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactTree);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redact(key), redactTree(entry)]),
    );
  }
  return value;
}

async function runSuite() {
  const { cases } = await import('../evals/jev-smoke-cases.mjs');
  if (cases.length > 20) throw new Error('This smoke suite is limited to 20 inference requests');
  const started = performance.now();
  const results = [];
  for (const fixture of cases) {
    if (performance.now() - started > 180000) break;
    const result = await request('/v1/systemone', {
      model,
      state: fixture.state,
      questions: fixture.questions,
    });
    const answers = {};
    let correct = result.status === 200;
    for (const [id, question] of Object.entries(fixture.questions)) {
      const answer = result.data?.answers?.[id];
      const issues = validateAnswer(question, answer);
      const expected = fixture.expected[id];
      const matches =
        answer &&
        (expected.choice !== undefined
          ? answer.choice === expected.choice
          : expected.minScore !== undefined
            ? answer.score >= expected.minScore
            : answer.score <= expected.maxScore);
      answers[id] = {
        type: answer?.type,
        choice: answer?.choice,
        score: answer?.score,
        confidence: answer?.confidence,
        probabilities: answer?.probabilities,
        expected,
        valid: issues.length === 0,
        issues,
        matches: Boolean(matches),
      };
      correct &&= issues.length === 0 && Boolean(matches);
    }
    const entry = {
      id: fixture.id,
      task: fixture.task,
      ...summarize(result),
      returnedModel: result.data?.model,
      usage: result.data?.usage,
      answers,
      correct,
    };
    results.push(entry);
    console.log(
      JSON.stringify(
        redactTree({
          id: fixture.id,
          status: result.status,
          elapsedMs: result.elapsedMs,
          correct,
          answers,
        }),
      ),
    );
    if (results.length >= 3 && results.slice(-3).every((item) => item.status !== 200)) break;
  }
  const byTask = {};
  for (const result of results) {
    const task = (byTask[result.task] ??= { total: 0, passed: 0, latencies: [] });
    task.total += 1;
    task.passed += Number(result.correct);
    task.latencies.push(result.elapsedMs);
  }
  const report = redactTree({
    recordedAt: new Date().toISOString(),
    kind: 'handwritten-synthetic-smoke-checks',
    endpoint: base.origin,
    requestedModel: model,
    returnedModels: [...new Set(results.map((item) => item.returnedModel).filter(Boolean))],
    plannedRequests: cases.length,
    completedRequests: results.length,
    passed: results.filter((item) => item.correct).length,
    httpSucceeded: results.filter((item) => item.status === 200).length,
    latencyMs: {
      all: latencySummary(results.map((item) => item.elapsedMs)),
      successful: latencySummary(
        results.filter((item) => item.status === 200).map((item) => item.elapsedMs),
      ),
    },
    usage: {
      inputTokens: results.reduce((sum, item) => sum + (Number(item.usage?.input_tokens) || 0), 0),
      outputTokens: results.reduce(
        (sum, item) => sum + (Number(item.usage?.output_tokens) || 0),
        0,
      ),
      requestsWithoutUsage: results.filter((item) => !item.usage).length,
    },
    byTask: Object.fromEntries(
      Object.entries(byTask).map(([name, item]) => [
        name,
        {
          total: item.total,
          passed: item.passed,
          latencyMs: latencySummary(item.latencies),
        },
      ]),
    ),
    limitations: [
      'Synthetic smoke checks do not establish production accuracy or calibrated confidence.',
      'No baseline-provider calls were made; this report does not establish a comparative speedup.',
      'Latency is measured from this machine through the configured relay, including response-body receipt.',
      'An alias echoed by the relay does not establish the underlying resolved model version.',
    ],
    results,
  });
  const reportDir = resolve('testdata/jev-probe');
  await mkdir(reportDir, { recursive: true });
  await writeFile(resolve(reportDir, 'suite.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  const { results: omitted, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = report.passed === cases.length ? 0 : 1;
}

if (process.argv.includes('--suite')) {
  await runSuite();
} else {
  const fixture = {
    state: { user_message: '这个地方太远了，我想在附近找一个。' },
    questions: {
      intent: {
        type: 'choice',
        instructions: '只根据用户表达选择主要拒绝原因，不推测其他偏好。',
        criteria: {
          too_far: '用户认为距离太远，希望缩短路程。',
          too_expensive: '用户认为价格太高。',
          not_interested: '用户不喜欢这个地点或体验类型。',
          unknown: '无法确定拒绝原因。',
        },
      },
    },
  };

  const models = await request('/v1/models');
  const modelIds = Array.isArray(models.data?.data)
    ? models.data.data.map((item) => item.id).filter((id) => typeof id === 'string')
    : [];
  const native = await request('/v1/systemone', { model, ...fixture });
  const answer = native.data?.answers?.intent;
  const report = {
    recordedAt: new Date().toISOString(),
    endpoint: base.origin,
    requestedModel: model,
    models: {
      ...summarize(models),
      count: modelIds.length,
      jevModels: modelIds.filter((id) => /jev/i.test(id)),
    },
    native: {
      ...summarize(native),
      returnedModel: native.data?.model,
      topLevelKeys:
        native.data && typeof native.data === 'object'
          ? Object.keys(native.data).slice(0, 12).map(redact)
          : [],
      answer: answer
        ? {
            type: answer.type,
            choice: answer.choice,
            confidence: answer.confidence,
            probabilities: answer.probabilities,
          }
        : null,
      expected: 'too_far',
      correct: answer?.choice === 'too_far',
      usage: native.data?.usage,
    },
  };
  const reportDir = resolve('testdata/jev-probe');
  await mkdir(reportDir, { recursive: true });
  const safeReport = redactTree(report);
  await writeFile(
    resolve(reportDir, 'discovery.json'),
    JSON.stringify(safeReport, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify(safeReport, null, 2));
  process.exitCode = native.status === 200 && answer?.choice === 'too_far' ? 0 : 1;
}
