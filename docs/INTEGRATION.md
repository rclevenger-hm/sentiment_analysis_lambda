# Integration

Use the signed Node CLI after `npm ci`; it resolves normal AWS profiles, environment credentials and temporary role sessions. Set `AWS_REGION` and `API_ENDPOINT` to the API stage base URL. An old URL ending in `/analyze-sentiment` is normalized by the client. Production clients require a dedicated consumer role with `execute-api:Invoke` permission.

```bash
npm run client -- analyze 'The service works well.'
npm run client -- submit examples/feedback.csv --targeted --key october-reviews-01
npm run client -- status JOB_ID
npm run client -- results JOB_ID --limit 50 --offset 0
npm run client -- report JOB_ID --source support --from 2026-10-01 --to 2026-10-31
npm run client -- export JOB_ID --format json --out results.json
npm run client -- compare CURRENT_JOB_ID BASELINE_JOB_ID
npm run client -- history --limit 20
npm run client -- rule examples/alert-rule.json
npm run client -- alerts
npm run client -- acknowledge JOB_ID
npm run client -- usage
```

Bulk JSON uses `{records:[...],targeted:true}`; CSV has fixed supported column names. Map source-system columns to `id,text,languageCode,date,product,source` before submission. `--targeted` works for either upload format. Preserve the printed key if a submission times out. The CLI does not automatically resubmit work or poll indefinitely. Query status until terminal, then inspect per-record errors.

For Node applications, import `request` from `scripts/client.mjs`; it accepts method/body/contentType/idempotencyKey and returns status/contentType/text. Requests have finite timeouts. Follow `nextCursor` for history/alerts and `nextOffset` for records. Export requests return a signed URL; the CLI downloads its contents automatically when using `export`, including `--out`.

Python's example uses boto3/botocore signing (`pip install boto3`). Do not put long-lived AWS credentials in browser code. A browser application should use a backend that signs calls on behalf of its authorized users, or a separately designed short-lived identity flow with distinct tenant roles. The browser example is an informational page, not an unauthenticated live client.

The API's confidence scores are not calibrated probabilities of business impact. Targeted entities describe what the text discusses; they do not establish urgency or a root cause. Validate analysis quality on labeled examples from your domain before automating business decisions.
