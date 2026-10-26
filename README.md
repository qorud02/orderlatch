# OrderLatch

OrderLatch is a working prototype for reviewing a custom manufacturing order before a PayPal Sandbox payment. It compares a buyer request with a supplier quote, shows the source evidence for nine critical terms, and binds the review and demo acknowledgements to the same order revision.

The included café cup order is fictional sample data. The project does not claim customer deployments, measured business outcomes, or completed independent evaluation.

## What the prototype does

1. Accepts two English source texts: the buyer request and supplier quotation.
2. Calls OpenAI on the server to extract candidate values and literal quoted evidence independently from each text.
3. Applies server rules to check evidence, normalize supported values, compare terms, and calculate the amount in integer minor units.
4. Blocks checkout while a critical value is missing, uncertain, unsupported, or different, or the active proof version does not match the documents.
5. Records a buyer and supplier **demo persona acknowledgement** against the current snapshot hash.
6. Creates a PayPal Sandbox order using the server-calculated amount and revision reference.
7. Checks the authoritative PayPal order and capture before showing a completed payment.

The nine fields are quantity, capacity, material, print colors, proof version, delivery date, currency, unit price, and shipping. Supported payment currencies are USD, EUR, and GBP; other codes are blocked without currency conversion. The included scenario uses USD and a total of USD 120.00: 600 cups × USD 0.18 + USD 12.00 shipping. These are sample order values, not performance measurements.

Source edits and proof changes invalidate the previous analysis, both acknowledgements, and the checkout for that revision. Running a new comparison also requires fresh acknowledgements. Pending or completed payment states restrict changes to the existing order.

## Run locally

Requirements:

- Node.js 22 or newer, including npm.
- An OpenAI API key with access to the configured model for live comparisons.
- Your own PayPal **Sandbox** REST app credentials and a separate Sandbox buyer account for the payment flow.

There are no third-party npm dependencies and no build step. From the repository directory, with the required variables already in the process environment:

```sh
npm start
```

Open [http://127.0.0.1:4318](http://127.0.0.1:4318).

`npm start` does **not** automatically load a `.env` file. You can set environment variables through your shell or secret manager. Alternatively, copy `.env.example` to an untracked local `.env`, fill in your own credentials, and explicitly ask Node to load it:

```sh
node --env-file=.env server.mjs
```

Keep keys and secrets out of the repository, screenshots, recordings, and browser code. `.env` and `.data/` are ignored by Git. The server uses the credentials; the frontend receives configuration status, not the secret values.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server listen address. Keep the local prototype on loopback. |
| `PORT` | `4318` | HTTP port. The optional Python local launcher uses `4178` by default. |
| `OPENAI_API_KEY` | Empty | Server-side OpenAI API key. Missing configuration disables live comparison. |
| `OPENAI_MODEL` | `gpt-5.4-mini-2026-03-17` | Runtime extraction model. The configured account must have access. |
| `AI_BUDGET_USD` | `1` | Application estimate budget shared by the server process. See the limitations below. |
| `PAYPAL_CLIENT_ID` | Empty | Sandbox REST app client ID. |
| `PAYPAL_CLIENT_SECRET` | Empty | Matching Sandbox REST app secret. |
| `PAYPAL_MERCHANT_ID` | Empty | Optional explicit merchant ID used to set and verify the expected payee. Recommended for a controlled payment test. |
| `DATA_FILE` | Unset | Optional state JSON path, resolved relative to the application directory. Without it, sessions are held in memory. |

The OpenAI provider uses the Responses API with a structured JSON schema and `store: false`. The PayPal provider uses only `https://api-m.sandbox.paypal.com`; this code has no live PayPal endpoint mode.

The optional `scripts/run-local.py` is a local configuration helper that also requires Python. It is not needed for the Node/npm route above. Its default application port is `4178`, rather than the server's default `4318`.

## Reproduce the review and payment flow

Use fictional or non-sensitive text while evaluating the prototype.

1. Open the review desk and load **Mismatch**. The supplier quote differs in quantity, capacity, and proof version. Run the AI comparison and inspect the quoted evidence. Checkout should remain blocked.
2. Load **Aligned** and run the comparison. Inspect all nine values and source excerpts. If the AI response is incomplete or uncertain, resolve the wording and compare again; an aligned sample is not a guaranteed model result.
3. Acknowledge the current revision as the demo buyer, then as the demo supplier. Both actions happen in the same browser session.
4. Create the test order. The server supplies the amount, currency, and revision reference to PayPal.
5. Open the PayPal Sandbox approval link. Sign in with your Sandbox buyer account and approve the test transaction. Return to OrderLatch.
6. Select **Verify & capture**. The server retrieves the PayPal order and checks the order ID, amount, currency, version reference, and configured merchant identity before accepting a completed capture.
7. If PayPal returns an uncertain or pending capture, keep the same order and verify it again. A pending state is not a completed payment. A confirmed capture displays its identifiers and enables a sample review receipt download.

To inspect revision invalidation, edit a source or replace the proof **before capture**, then save. The old acknowledgements and checkout must no longer authorize the new revision. An uploaded proof receives a content hash and version label; the prototype does not visually inspect the artwork.

Other included samples cover an ambiguous currency symbol and a document containing an instruction override. They are test inputs for the review gate, not evidence that arbitrary prompt injection is solved.

PayPal Sandbox uses test accounts and test transactions. Judges should supply their own Sandbox and OpenAI credentials; no shared public instance or reusable credentials are provided.

## Tests and implementation

```sh
npm test
npm run check
node --check public/app.js
```

The 29 automated tests use explicit fixtures and mocked providers. They cover field comparison and evidence rejection, exact money calculation, revision/hash binding, both demo acknowledgements, session isolation, stale AI responses, checkout deduplication, concurrent capture handling, authoritative payment mismatches, and pending-outcome reconciliation. They do not make live OpenAI or PayPal calls and do not establish extraction accuracy or production payment reliability.

`npm run check` checks syntax for the server and provider/domain modules. The separate command above checks the browser script. Interactive browser review and live service verification are separate from these automated checks.

| File | Role |
| --- | --- |
| `server.mjs` | HTTP routes, sessions, mutation serialization, persistence, and checkout orchestration. |
| `lib/domain.mjs` | Field normalization, quoted evidence checks, blockers, revision hashes, acknowledgements, and payment validation. |
| `lib/providers.mjs` | OpenAI extraction, estimated usage budget, and PayPal Sandbox requests. |
| `public/` | Responsive vanilla JavaScript review workbench. |
| `test/` | Offline domain and HTTP tests with mocked external services. |

## Recorded development checks

The repository includes dated, synthetic development evidence. These are narrow reproducible checks, not a field trial or an independent estimate of real-world accuracy.

| Same 24 frozen English source pairs | Incorrectly allowed blocked cases | Incorrectly blocked valid cases |
| --- | ---: | ---: |
| Literal field-label baseline | 2 | 6 |
| AI value agreement only, final pass | 1 | 0 |
| OrderLatch evidence and revision rules, first pass | 0 | 4 |
| OrderLatch evidence and revision rules, final pass | 0 | 0 |

The set contains eight expected-ready pairs and sixteen expected-blocked pairs. The first pass exposed valid word-number, shipping-label, lowercase-currency, named-month, and decimal-capacity wording that was rejected. The extraction instructions and deterministic date/unit checks were corrected, then the same unchanged set was rerun. Both passes are preserved in `evidence/evaluation-pass1.json` and `evidence/evaluation-pass2.json`. Because development used these examples, the final result does not establish generalization or arbitrary-injection resistance. Estimated OpenAI usage for the two full passes was USD 0.13479.

`evidence/sandbox-capture-receipt.json` records one real PayPal Sandbox USD 120.00 capture with the same revision hash in both demo acknowledgements and the captured order. `evidence/live-protocol-results.json` records 16 checks against another actual Sandbox order: repeated creation reused the order, a source edit cleared both acknowledgements, and the stale order could not be captured using the old hash, a new unreviewed hash, or another session. That second order was deliberately left uncaptured. Sandbox test funds carry no real monetary value.

A separate six-case synthetic challenge was fixed after the first improvement. Its first observation correctly handled five cases and missed a new instruction telling the automated reviewer to skip approval and release funds. The source text did not execute a payment, but the review gate failed to flag it. The first result is preserved in `evidence/postfreeze-first-observation.json`. General imperative override patterns were added; the known attack, a normal GBP order, and unsupported KRW were then checked again and all three behaved as expected (`evidence/known-case-retest.json`). Those three are regression checks on known inputs, not a new unseen accuracy result.

To rerun the synthetic development set against your own configured local server:

```sh
node scripts/evaluate.mjs
```

The evaluator defaults to port `4179`; set `EVAL_URL` to your local server origin when needed. It sends the 24 fictional pairs to your configured OpenAI model and writes new evidence files. Preserve existing reports first if comparing versions. The optional `scripts/check-live-protocol.mjs` requires `RUN_LIVE_SANDBOX=1`, defaults to port `4178`, and creates an actual uncaptured Sandbox order.

## AI use

**Codex was used for research, architecture, implementation, UI, tests, and documentation.** At runtime, OpenAI extracts candidate terms and quotations from the two source documents. Server rules determine whether the review and payment gate can proceed. The model does not receive payment credentials or execute a payment tool.

The configured default runtime model is `gpt-5.4-mini-2026-03-17`. Generated candidates can still be wrong. Evidence and rule checks narrow the accepted inputs; the displayed excerpts remain available for review.

## Current scope and limitations

- This is a narrow English order-review prototype for the nine listed fields. It is not a general contract interpreter, legal review, escrow service, fulfillment guarantee, or dispute-resolution system.
- Both acknowledgement roles belong to one demo session. There are no independently authenticated buyer and supplier accounts, identity checks, electronic signatures, or access-controlled invitations. Independent roles are future work.
- Proof handling records a version label and SHA-256 hash. Uploaded file bytes are not retained or visually analyzed. A matching label and hash bind a revision; they do not prove visual artwork quality or real supplier acceptance.
- Extraction and evidence checks can reject unfamiliar valid wording or miss meaning outside the supported rules. The system does not claim general prompt-injection resistance or verified agreement on every possible commercial term.
- The server keeps sessions in memory by default. Optional `DATA_FILE` persistence stores source text, review state, acknowledgements, payment identifiers, and estimated AI spend. Protect that file and avoid sensitive input. Source texts are sent to OpenAI for comparison; order references and payment amounts are sent to PayPal Sandbox.
- The application budget uses hard-coded token price estimates for the default model. It is not an OpenAI account billing limit or a guarantee of exact charges. Changing models requires reviewing the estimate. Failed requests and interrupted processes can affect accounting.
- This local prototype has no production user authentication, per-user quotas, public abuse controls, operational monitoring, or complete payment lifecycle such as refunds, terminal-failure recovery, or webhooks. Do not expose a server containing funded API credentials to the public as-is.
- The recorded live-service checks and synthetic development results do not establish production reliability, independent human acceptance, customer adoption, or an award.

## License

MIT. See `LICENSE` for the license text.
