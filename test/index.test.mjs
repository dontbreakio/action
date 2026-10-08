import test from 'node:test';
import assert from 'node:assert/strict';

import { getInput, requestJson, pollUntilTerminal } from '../index.mjs';

// ---------------------------------------------------------------------------
// getInput: verify GitHub's INPUT_<NAME> env var convention, including that
// dashes in the input name are preserved (only spaces become underscores).
// ---------------------------------------------------------------------------

test('getInput reads INPUT_<NAME> with dashes preserved', () => {
  process.env['INPUT_SUITE-ID'] = '  42  ';
  try {
    assert.equal(getInput('suite-id'), '42');
  } finally {
    delete process.env['INPUT_SUITE-ID'];
  }
});

test('getInput throws when a required input is missing', () => {
  delete process.env['INPUT_MISSING-THING'];
  assert.throws(() => getInput('missing-thing', { required: true }), /Input required and not supplied: missing-thing/);
});

// ---------------------------------------------------------------------------
// requestJson: normalizes network errors, non-JSON bodies, and success.
// ---------------------------------------------------------------------------

test('requestJson surfaces network errors without throwing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  try {
    const result = await requestJson('http://example.invalid/x', {});
    assert.ok(result.networkError);
    assert.match(result.networkError.message, /ENOTFOUND/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestJson reports a parse error for non-JSON bodies', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html>not json</html>', { status: 200 });
  try {
    const result = await requestJson('http://example.invalid/x', {});
    assert.equal(result.data, null);
    assert.ok(result.parseError);
    assert.equal(result.response.ok, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestJson returns parsed data on success', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ status: 'passed' }), { status: 200 });
  try {
    const result = await requestJson('http://example.invalid/x', {});
    assert.deepEqual(result.data, { status: 'passed' });
    assert.equal(result.parseError, null);
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// pollUntilTerminal: polling cadence, timeout, and transient-failure
// tolerance. Uses an injected virtual clock/wait so the test runs instantly.
// ---------------------------------------------------------------------------

function virtualClock() {
  let currentTime = 0;
  return {
    now: () => currentTime,
    wait: async (ms) => {
      currentTime += ms;
    },
  };
}

function fetchSequence(steps) {
  let call = 0;
  return async () => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    if (step.error) {
      throw step.error;
    }
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
  };
}

test('pollUntilTerminal resolves once a terminal status is returned', async () => {
  const originalFetch = global.fetch;
  global.fetch = fetchSequence([
    { body: { status: 'pending', totalTests: 5 } },
    { body: { status: 'running', totalTests: 5, passed: 2 } },
    { body: { status: 'passed', totalTests: 5, passed: 5, failed: 0, durationMs: 1234, reportUrl: 'https://example.test/r' } },
  ]);
  const { now, wait } = virtualClock();
  try {
    const { timedOut, result } = await pollUntilTerminal({
      baseUrl: 'http://example.invalid',
      runId: 'run-1',
      apiKey: 'k',
      pollIntervalMs: 1000,
      timeoutMs: 60000,
      now,
      wait,
    });
    assert.equal(timedOut, false);
    assert.equal(result.status, 'passed');
    assert.equal(result.passed, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pollUntilTerminal reports a timeout once the deadline elapses', async () => {
  const originalFetch = global.fetch;
  global.fetch = fetchSequence([{ body: { status: 'running', totalTests: 5, passed: 1 } }]);
  const { now, wait } = virtualClock();
  try {
    const { timedOut, result } = await pollUntilTerminal({
      baseUrl: 'http://example.invalid',
      runId: 'run-1',
      apiKey: 'k',
      pollIntervalMs: 1000,
      timeoutMs: 2500,
      now,
      wait,
    });
    assert.equal(timedOut, true);
    assert.equal(result.status, 'running');
  } finally {
    global.fetch = originalFetch;
  }
});

test('pollUntilTerminal tolerates transient failures and recovers', async () => {
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call <= 2) {
      throw new Error('temporary network blip');
    }
    return new Response(JSON.stringify({ status: 'passed', passed: 3, failed: 0, totalTests: 3 }), { status: 200 });
  };
  const { now, wait } = virtualClock();
  try {
    const { timedOut, result } = await pollUntilTerminal({
      baseUrl: 'http://example.invalid',
      runId: 'run-1',
      apiKey: 'k',
      pollIntervalMs: 1000,
      timeoutMs: 60000,
      now,
      wait,
    });
    assert.equal(timedOut, false);
    assert.equal(result.status, 'passed');
    assert.equal(call, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pollUntilTerminal gives up after 3 consecutive failures', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('persistent network blip');
  };
  const { now, wait } = virtualClock();
  try {
    await assert.rejects(
      pollUntilTerminal({
        baseUrl: 'http://example.invalid',
        runId: 'run-1',
        apiKey: 'k',
        pollIntervalMs: 1000,
        timeoutMs: 60000,
        now,
        wait,
      }),
      /Giving up after 3 consecutive polling failures/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// ─── partial runs must not gate green ────────────────────────────────────────

test('decideOutcome fails a "passed" run that the API marks partial', async () => {
  const { decideOutcome } = await import('../index.mjs');
  const outcome = decideOutcome({ status: 'passed', passed: 3, failed: 0, partial: true, notLaunched: 2 }, false);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.notLaunched, 2);
  assert.match(outcome.message, /partial/i);
});

test('decideOutcome keeps a clean passed run green', async () => {
  const { decideOutcome } = await import('../index.mjs');
  const outcome = decideOutcome({ status: 'passed', passed: 3, failed: 0, partial: false, notLaunched: 0 }, false);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.partial, false);
});

test('decideOutcome fails on failed, cancelled and timeout', async () => {
  const { decideOutcome } = await import('../index.mjs');
  assert.equal(decideOutcome({ status: 'failed', passed: 1, failed: 1 }, false).exitCode, 1);
  assert.equal(decideOutcome({ status: 'cancelled', passed: 0, failed: 0 }, false).exitCode, 1);
  assert.equal(decideOutcome({ status: 'running' }, true).exitCode, 1);
  assert.equal(decideOutcome({ status: 'running' }, true).finalStatus, 'timeout');
});

test('decideOutcome keeps a run with unverified AI checks green but reports them', async () => {
  const { decideOutcome } = await import('../index.mjs');
  const outcome = decideOutcome({ status: 'passed', passed: 3, failed: 0, partial: false, notLaunched: 0, needsReview: 2 }, false);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.needsReview, 2);
  assert.match(outcome.message, /2 AI check\(s\) could not run/);
});

test('buildSummaryMarkdown lists AI checks that need review', async () => {
  const { buildSummaryMarkdown } = await import('../index.mjs');
  const md = buildSummaryMarkdown({ testName: 'Checkout', status: 'passed', passed: 3, failed: 0, totalTests: 3, needsReview: 1 });
  assert.match(md, /\*\*Needs review:\*\* 1 AI check\(s\) could not run/);
});
