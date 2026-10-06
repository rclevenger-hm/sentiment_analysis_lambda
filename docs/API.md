# API reference

All application routes require AWS IAM SigV4 authorization (`execute-api` signing service). Use the stage base URL from `api_base_url`. The bundled CLI signs requests through the standard credential chain. CORS preflight alone is unauthenticated.

## Routes

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/analyze-sentiment` | Synchronous analysis; no retained history |
| POST | `/jobs` | Submit CSV/JSON; returns 202 and a job ID, or the existing job |
| GET | `/jobs/{jobId}` | Status, processed/total counts, progress, expiry, and final summary |
| GET | `/jobs/{jobId}/results` | Completed records; pagination and filters |
| GET | `/jobs/{jobId}/report` | Filtered counts, negative rate, dated trends, concerns and evidence |
| GET | `/jobs/{jobId}/export` | Returns a 60-second download URL for CSV/JSON |
| GET | `/history` | Newest jobs first; cursor pagination and date/status filters |
| GET | `/compare` | Compare `current` and `baseline` job IDs with optional record filters |
| GET | `/usage` | Current UTC-day accepted inference units, limit, and reset time |
| GET / PUT | `/alert-rule` | Read/replace the caller's threshold rule |
| GET | `/alerts` | Paginated alert feed with evidence record IDs |
| PUT | `/alerts/{jobId}/acknowledge` | Acknowledge an alert |

## Single requests

```json
{"text":"The product is excellent, but delivery was late.","languageCode":"en","targeted":true}
```

The default language is `en` only when omitted. Supported codes: `ar`, `de`, `en`, `es`, `fr`, `hi`, `it`, `ja`, `ko`, `pt`, `zh`, `zh-TW`. Non-string language values are rejected. `targeted` defaults to false and supports English only. Successful responses preserve `sentiment` and `sentimentScore`; targeted requests also return `entities` and `entitiesTruncated`.

## Bulk submissions

Send `Idempotency-Key` (8–128 letters, digits, `.`, `_`, `:`, or `-`). Keys identify a submission within the authenticated principal. Reusing the same key/data returns the same job without charging the daily allowance twice. Different data under that key returns 409. New keys create new work, including intentional reprocessing.

JSON example:

```json
{
  "label":"October feedback",
  "targeted":true,
  "records":[
    {"id":"ticket-17","text":"The product is good, but delivery was late.","languageCode":"en","date":"2026-10-01","product":"widget","source":"support"},
    {"id":"review-12","text":"Easy to use.","product":"widget","source":"reviews"}
  ]
}
```

For `Content-Type: text/csv`, columns are `id,text,languageCode,date,product,source`; only `text` is required. Quoted commas, escaped quotes, BOM, CRLF and multiline fields are supported. Use `?targeted=true` for CSV. JSON sets `targeted` in its body. Dates must be valid `YYYY-MM-DD`. Missing IDs become `row-1`, `row-2`, etc.; duplicate or malformed IDs reject the upload. Labels and metadata fields are limited to 120 characters; IDs to 128.

Limits: 1 MiB decoded UTF-8 request body, 200 records per job, 5,000 UTF-8 bytes per text. API Gateway base64 bodies are decoded and checked. Invalid record text/language/metadata becomes a per-record error; malformed JSON/CSV or duplicate IDs rejects the submission. Targeted jobs mark non-English records as errors. No text is silently truncated.

Jobs move through `QUEUED`, `RUNNING`, then `COMPLETED`, `COMPLETED_WITH_ERRORS`, or `FAILED`. `processed` includes valid and invalid records. Workers checkpoint batches of 25. In-progress results expose checkpointed data; export and comparison require a terminal job. Failed-job exports include unprocessed records with explicit errors.

## Filters, reports and comparison

Results, reports, exports and comparisons accept `sentiment`, `product`, `source`, `languageCode`, `minConfidence` (0–1), and inclusive `from`/`to` dates. Dates use each record's date, falling back to the job's UTC submission date. Results accept `offset` (default 0) and `limit` (default 50, maximum 100).

History accepts `from`, `to` (job submission dates), `status`, `limit` (default 20, maximum 100), and `cursor`. Alerts accept `limit`/`cursor`. Timeline indexes are eventually consistent; immediate progress should use `/jobs/{jobId}`. Filtered pages can be empty while `nextCursor` remains set; follow it to continue.

`negativeRate` is negative / successfully analyzed records, or null when none succeeded. Insight failures are reported separately. Trends include only dates with records. Concerns group matching entity text case-insensitively and link up to three source excerpts per concern. They do not cluster synonyms or infer root causes. `negativeRateChange` in comparisons is current minus baseline as a fraction, not a relative percentage; samples are descriptive, not a significance test.

Targeted evidence is bounded to ten entities per record and three mentions per entity, with truncation flags and excerpts of up to 240 characters. Offsets refer to the trimmed text actually submitted to Comprehend. Confidence scores are model outputs, not guarantees of correctness.

## Exports and alerts

`/export?format=csv` or `format=json` returns `{downloadUrl,expiresInSeconds:60,recordCount,format}`. Download immediately without adding SigV4 headers; the URL is already signed. Treat it as a temporary bearer credential. Generate a new link if expired. CSV fields that could execute spreadsheet formulas are prefixed with an apostrophe; JSON preserves original values.

Set a rule before processing new jobs:

```json
{"enabled":true,"minRecords":5,"negativeRate":0.6,"filters":{"source":"support","minConfidence":0.7}}
```

One rule per caller is evaluated when a job finishes. It uses the current rule and successful matching records. Existing jobs are not retrospectively reevaluated. Alerts include the job ID and evidence record IDs, are deduplicated per job, and remain in the feed after acknowledgement until retention expires. These alerts do not send external messages.

## Usage and errors

Each accepted valid record reserves one daily inference unit; targeted records reserve two. Invalid bulk rows reserve none. Reservations are not refunded after upstream failure, and internal retries can still incur additional AWS charges. The allowance is an application admission control, not a billing cap. Single-request retries are separate calls; use bulk idempotency when retries must reuse work.

Errors return `{error,code,requestId}`. Statuses: 400 invalid request, 401 missing authenticated principal, 403 IAM denial from API Gateway, 404 unknown/not-owned resource, 409 conflict or unfinished job, 413 size limit, 415 unsupported bulk content type, 429 daily/gateway throttle, 502 single upstream failure, 503 temporary storage/queue failure. Application 429 responses provide `Retry-After` until UTC midnight. Gateway errors have gateway-managed bodies. Responses expose `x-request-id` through CORS and disable caching. Request bodies and feedback text are not logged.
