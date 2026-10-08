// DontBreak GitHub Action
//
// Zero-dependency implementation: Node 20 built-ins only (global fetch, fs).
// Re-implements the tiny slice of @actions/core we need by hand so the
// action ships with no node_modules and no supply-chain surface.

import { appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Minimal actions-toolkit shim
// ---------------------------------------------------------------------------

/**
 * GitHub exposes each workflow input as an environment variable named
 * INPUT_<name>, where <name> is the input name upper-cased and with spaces
 * turned into underscores. Dashes are left untouched, so `suite-id` becomes
 * `INPUT_SUITE-ID` (verified against GitHub's documented convention and by
 * inspecting `env | grep INPUT_` inside a live workflow run).
 */
function getInput(name, { required = false } = {}) {
  const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = process.env[envName] ?? '';
  const trimmed = value.trim();
  if (required && trimmed === '') {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return trimmed;
}

function getInputOrDefault(name, defaultValue) {
  const value = getInput(name);
  return value === '' ? defaultValue : value;
}

/** Escape a value for the `::workflow-command key=value::` wire format. */
function escapeData(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function errorAnnotation(message) {
  console.log(`::error::${escapeData(message)}`);
}

function warningAnnotation(message) {
  console.log(`::warning::${escapeData(message)}`);
}

/** Append a single `name=value` line to $GITHUB_OUTPUT. */
function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (!outputPath) {
    // Not running inside GitHub Actions (or not wired up for a local test
    // run) - fall back to stdout so nothing is silently lost.
    warningAnnotation(`GITHUB_OUTPUT is not set; would have written: ${line.trim()}`);
    return;
  }
  appendFileSync(outputPath, line);
}

/** Append a chunk of Markdown to the job summary. */
function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    warningAnnotation('GITHUB_STEP_SUMMARY is not set; skipping job summary.');
    return;
  }
  appendFileSync(summaryPath, markdown);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// DontBreak API client
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'cancelled']);
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * Perform a fetch and normalize the three ways it can go wrong:
 * a network-level failure, a non-2xx HTTP status, and a 2xx response body
 * that isn't valid JSON.
 */
async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    return { networkError: err };
  }

  const text = await response.text();
  let data = null;
  let parseError = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      parseError = err;
    }
  }

  return { response, text, data, parseError };
}

function summarizeBody(text) {
  if (!text) return '(empty body)';
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

async function launchSuite({ baseUrl, suiteId, apiKey, secret }) {
  const url = `${baseUrl}/api/launch/suite/${encodeURIComponent(suiteId)}`;
  const result = await requestJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ secret }),
  });

  if (result.networkError) {
    throw new Error(`Network error while launching suite ${suiteId}: ${result.networkError.message}`);
  }

  const { response, data, parseError, text } = result;

  if (!response.ok) {
    const message = data && data.message ? data.message : summarizeBody(text);
    throw new Error(`Failed to launch suite (HTTP ${response.status}): ${message}`);
  }

  if (parseError || !data) {
    throw new Error(
      `Launch request returned HTTP ${response.status} but the response body was not valid JSON: ${summarizeBody(text)}`
    );
  }

  if (data.status === 'error') {
    throw new Error(`Failed to launch suite: ${data.message || 'unknown error'}`);
  }

  return data;
}

async function fetchRunStatus({ baseUrl, runId, apiKey }) {
  const url = `${baseUrl}/api/results/run/${encodeURIComponent(runId)}`;
  const result = await requestJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (result.networkError) {
    throw new Error(`Network error while polling run ${runId}: ${result.networkError.message}`);
  }

  const { response, data, parseError, text } = result;

  if (!response.ok) {
    const message = data && data.message ? data.message : summarizeBody(text);
    throw new Error(`Failed to fetch run status (HTTP ${response.status}): ${message}`);
  }

  if (parseError || !data) {
    throw new Error(
      `Status request returned HTTP ${response.status} but the response body was not valid JSON: ${summarizeBody(text)}`
    );
  }

  return data;
}

/**
 * Poll `fetchRunStatus` until a terminal status is reached or the timeout
 * elapses. Tolerates up to MAX_CONSECUTIVE_POLL_FAILURES consecutive
 * transport/parse errors before giving up, so a single flaky response
 * doesn't fail the whole run.
 */
async function pollUntilTerminal({ baseUrl, runId, apiKey, pollIntervalMs, timeoutMs, now = Date.now, wait = sleep }) {
  const deadline = now() + timeoutMs;
  let consecutiveFailures = 0;

  while (true) {
    let result;
    try {
      result = await fetchRunStatus({ baseUrl, runId, apiKey });
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      warningAnnotation(
        `Poll attempt failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err.message}`
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`Giving up after ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive polling failures: ${err.message}`);
      }
      result = null;
    }

    if (result) {
      console.log(
        `Status: ${result.status}${result.totalTests != null ? ` (${result.passed ?? 0}/${result.totalTests} passed)` : ''}`
      );
      if (TERMINAL_STATUSES.has(result.status)) {
        return { timedOut: false, result };
      }
    }

    if (now() >= deadline) {
      return { timedOut: true, result };
    }

    await wait(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Job summary
// ---------------------------------------------------------------------------

function buildSummaryMarkdown({ testName, status, passed, failed, totalTests, durationMs, reportUrl, partial, notLaunched, needsReview }) {
  const lines = [
    '## DontBreak — E2E Test Suite',
    '',
    `**Suite:** ${testName || '(unnamed)'}`,
    `**Result:** ${status}`,
    `**Passed:** ${passed ?? 'n/a'}${totalTests != null ? ` / ${totalTests}` : ''}`,
    `**Failed:** ${failed ?? 'n/a'}`,
    ...(partial ? [`**Partial run:** yes — ${notLaunched ?? 0} test(s) never launched`] : []),
    ...(needsReview ? [`**Needs review:** ${needsReview} AI check(s) could not run because the AI service was unavailable`] : []),
  ];
  if (durationMs != null) {
    lines.push(`**Duration:** ${(durationMs / 1000).toFixed(1)}s`);
  }
  if (reportUrl) {
    lines.push('', `[View full report](${reportUrl})`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const suiteId = getInput('suite-id', { required: true });
  const apiKey = getInput('api-key', { required: true });
  const secret = getInput('secret', { required: true });
  const baseUrl = getInputOrDefault('base-url', 'https://app.dontbreak.io').replace(/\/+$/, '');
  const waitInput = getInputOrDefault('wait', 'true').toLowerCase();
  const shouldWait = waitInput !== 'false' && waitInput !== '0' && waitInput !== 'no';
  const timeoutMinutes = Number(getInputOrDefault('timeout-minutes', '30')) || 30;
  const pollIntervalSeconds = Number(getInputOrDefault('poll-interval', '10')) || 10;

  console.log(`Launching DontBreak suite ${suiteId} against ${baseUrl}...`);
  const launch = await launchSuite({ baseUrl, suiteId, apiKey, secret });

  const runId = launch.runId;
  console.log(`Run started: ${runId} (${launch.testName || 'unnamed suite'})`);
  if (launch.message) {
    console.log(launch.message);
  }
  console.log(`Launched ${launch.launched ?? '?'} of ${launch.totalTests ?? '?'} tests.`);

  setOutput('run-id', runId ?? '');

  if (!shouldWait) {
    setOutput('status', 'running');
    setOutput('passed', '');
    setOutput('failed', '');
    setOutput('report-url', '');
    writeSummary(
      buildSummaryMarkdown({
        testName: launch.testName,
        status: 'running (not waited for)',
        passed: undefined,
        failed: undefined,
        totalTests: launch.totalTests,
      })
    );
    console.log('wait=false: not waiting for the run to finish.');
    return;
  }

  const { timedOut, result } = await pollUntilTerminal({
    baseUrl,
    runId,
    apiKey,
    pollIntervalMs: pollIntervalSeconds * 1000,
    timeoutMs: timeoutMinutes * 60 * 1000,
  });

  const outcome = decideOutcome(result, timedOut);
  const { finalStatus, passed, failed, partial, notLaunched, needsReview } = outcome;
  const reportUrl = result ? result.reportUrl ?? '' : '';

  setOutput('status', finalStatus);
  setOutput('passed', String(passed));
  setOutput('failed', String(failed));
  setOutput('partial', String(partial));
  setOutput('not-launched', String(notLaunched));
  setOutput('needs-review', String(needsReview));
  setOutput('report-url', reportUrl);

  writeSummary(
    buildSummaryMarkdown({
      testName: launch.testName,
      status: finalStatus,
      passed,
      failed,
      totalTests: result ? result.totalTests : launch.totalTests,
      durationMs: result ? result.durationMs : undefined,
      reportUrl,
      partial,
      notLaunched,
      needsReview,
    })
  );

  if (needsReview > 0) {
    warningAnnotation(`${needsReview} AI check(s) could not run because the AI service was unavailable. Check them in the report.`);
  }

  if (timedOut) {
    errorAnnotation(
      `Timed out after ${timeoutMinutes} minute(s) waiting for run ${runId} to finish (last known status: ${
        result ? result.status : 'unknown'
      }).`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Final status: ${finalStatus}. Passed: ${passed}, Failed: ${failed}.`);
  if (reportUrl) {
    console.log(`Report: ${reportUrl}`);
  }

  if (outcome.exitCode !== 0) {
    errorAnnotation(`DontBreak suite run ${runId}: ${outcome.message}`);
    process.exitCode = 1;
  }
}

/**
 * Decide whether the workflow step should go red. A run the API reports as
 * `passed` can still be `partial` (some tests never launched — quota, capacity,
 * or a cancelled stage), and a gate that only reads `status` would wave a
 * half-executed suite through. Partial is therefore a failure here.
 */
function decideOutcome(result, timedOut) {
  const finalStatus = timedOut ? 'timeout' : result ? result.status : 'unknown';
  const passed = result ? result.passed ?? 0 : 0;
  const failed = result ? result.failed ?? 0 : 0;
  const partial = Boolean(result && result.partial);
  const notLaunched = result ? result.notLaunched ?? 0 : 0;
  // AI checks that couldn't run (AI service unavailable) don't fail the run,
  // but they weren't verified either, so say so.
  const needsReview = result ? result.needsReview ?? 0 : 0;

  let exitCode = 0;
  let message = `finished with status "${finalStatus}" (${passed} passed, ${failed} failed).`;

  if (timedOut) {
    exitCode = 1;
    message = `timed out (last known status: ${result ? result.status : 'unknown'}).`;
  } else if (finalStatus === 'failed' || finalStatus === 'cancelled') {
    exitCode = 1;
  } else if (partial) {
    exitCode = 1;
    message = `finished with status "${finalStatus}" but the run was partial: ${notLaunched} test(s) never launched (${passed} passed, ${failed} failed). Treating as a failure.`;
  }

  if (needsReview > 0 && !timedOut) {
    message += ` ${needsReview} AI check(s) could not run because the AI service was unavailable; check them in the report.`;
  }

  return { finalStatus, passed, failed, partial, notLaunched, needsReview, exitCode, message };
}

// Only auto-run when executed directly (`node index.mjs`), not when imported
// by unit tests.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  run().catch((err) => {
    errorAnnotation(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { getInput, getInputOrDefault, requestJson, pollUntilTerminal, buildSummaryMarkdown, decideOutcome, run };
