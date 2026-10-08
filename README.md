# DontBreak GitHub Action

Run a [DontBreak](https://dontbreak.io) visual end-to-end test suite from your GitHub Actions workflow — and gate your pipeline on the result.

The action launches the suite through the DontBreak API, polls the run until it finishes, and fails the job if the suite fails, is cancelled, or times out. Set `wait: 'false'` if you only want to trigger the suite and move on.

## Quick start

```yaml
- name: Run DontBreak E2E suite
  uses: dontbreakio/action@v1
  with:
    suite-id: 'your-suite-uuid'
    api-key: ${{ secrets.DONTBREAK_API_KEY }}
    secret: ${{ secrets.DONTBREAK_SECRET }}
```

1. In DontBreak, go to **Automation → CI/CD Pipelines**, select the **GitHub Actions** tab, and click **Generate Credentials**. Copy the API key and secret immediately — they are shown only once.
2. Store them as [repository secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets) named `DONTBREAK_API_KEY` and `DONTBREAK_SECRET`.
3. The suite ID is the suite's UUID, visible in your browser's address bar when viewing the suite.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `suite-id` | yes | — | UUID of the test suite to run. |
| `api-key` | yes | — | DontBreak API key (Bearer token). Store as a secret. |
| `secret` | yes | — | DontBreak integration secret. Store as a secret. |
| `base-url` | no | `https://app.dontbreak.io` | Base URL of the DontBreak API. |
| `wait` | no | `'true'` | Wait for the run to finish and gate the job on the result. Set `'false'` to fire-and-forget. |
| `timeout-minutes` | no | `'30'` | Maximum time to wait for a result before failing with status `timeout`. |
| `poll-interval` | no | `'10'` | Seconds between status polls while waiting. |

## Outputs

| Output | Description |
| --- | --- |
| `run-id` | Unique ID of this suite run. |
| `status` | `passed`, `failed`, `cancelled`, `timeout`, or `running` (when `wait: 'false'`). |
| `passed` | Number of tests that passed. |
| `failed` | Number of tests that failed. |
| `partial` | `true` when some suite tests never launched (quota, capacity, cancelled stage). The step fails in that case even if `status` is `passed`. |
| `not-launched` | Number of suite tests that never launched. |
| `needs-review` | Number of AI checks that couldn't run because the AI service was unavailable. They don't fail the run; the step logs a warning and the job summary lists them. |
| `report-url` | Link to the full report in DontBreak. |

## Gate behavior

With `wait: 'true'` (the default), the job step:

- exits **0** when every test in the suite passes,
- exits **non-zero** when the run ends `failed` or `cancelled`, or when `timeout-minutes` elapses,
- writes a job summary with the result, pass/fail counts, duration, and a link to the report.

A quota-exhausted or inactive subscription fails the launch immediately with a clear error (HTTP 402), as do invalid credentials (401), a disabled integration (403), and an unknown suite (404) — the step never reports green unless tests actually ran.

## Fire-and-forget

```yaml
- name: Trigger DontBreak suite (don't wait)
  uses: dontbreakio/action@v1
  with:
    suite-id: 'your-suite-uuid'
    api-key: ${{ secrets.DONTBREAK_API_KEY }}
    secret: ${{ secrets.DONTBREAK_SECRET }}
    wait: 'false'
```

The step succeeds as soon as the suite is launched (`status` output is `running`); results arrive via your DontBreak Slack/email alerts, or poll them yourself:

```bash
curl -H "Authorization: Bearer $DONTBREAK_API_KEY" \
  https://app.dontbreak.io/api/results/run/{run-id}
```

## Using outputs

```yaml
- name: Run DontBreak E2E suite
  id: e2e
  uses: dontbreakio/action@v1
  with:
    suite-id: 'your-suite-uuid'
    api-key: ${{ secrets.DONTBREAK_API_KEY }}
    secret: ${{ secrets.DONTBREAK_SECRET }}

- name: Show report link
  if: always()
  env:
    STATUS: ${{ steps.e2e.outputs.status }}
    REPORT: ${{ steps.e2e.outputs.report-url }}
  run: echo "Suite finished with $STATUS — $REPORT"
```

## Security

- Always pass `api-key` and `secret` from GitHub secrets — never commit them.
- Regenerating credentials in DontBreak invalidates the old pair immediately; update your repository secrets when you rotate.
- The action has zero runtime dependencies and never logs your credentials.

## Requirements

- A DontBreak account with an active subscription (suite launches consume plan test runs).
- The GitHub Actions integration enabled under **Automation → CI/CD Pipelines**.

## License

[ISC](LICENSE)
