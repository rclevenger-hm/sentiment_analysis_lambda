# Operations

## Verification

Run `npm ci && npm run lint && npm test && npm run build`. Terraform CI checks formatting, validates both stacks, and uses mock-provider plans to check infrastructure controls. A manual deployment runs an authenticated single-request smoke test. None of these substitutes for the deferred live resilience/rollback acceptance checks in issue #12.

## Jobs and retries

The API stores immutable input in private S3, then atomically creates the job and reserves the caller's daily allowance in DynamoDB. Queue delivery can be duplicated. The worker acquires a conditional 180-second lease for a 120-second Lambda execution and persists a 25-record result chunk before committing the checkpoint. Checkpoints require the matching lease token and previous offset. Completed work is not rerun after a successful checkpoint.

Transient service/batch-item failures return SQS partial failures. Permanent errors become per-record failures; targeted-only errors retain the overall sentiment and report `insightsError`. Retries may repeat inference when a process dies before checkpointing; admission metering remains once per job, but AWS charges for actual service calls can increase. At most five worker claims are permitted per checkpoint. Exhausted jobs become `FAILED`; completed records remain available and exports identify unprocessed rows.

A 15-minute recovery sweep requeues jobs that have not changed for 15 minutes and have no active lease, covering the transaction-to-enqueue and checkpoint-to-enqueue gaps. It paginates the table and signals an error if its time budget expires; monitor this as retained history grows. This small-service implementation uses a bounded-page table scan, not an unbounded in-memory scan. SQS redrive after five receives provides a second failure path; the dead-letter consumer marks stalled jobs failed. Use a new submission key for an intentional retry of a terminal failed job.

## Observability

Request logs contain request ID, status, and duration; worker logs contain job IDs, progress, and error names. Raw feedback, credentials, signed download URLs and upstream error messages are not logged. CloudWatch alarms cover API 5xx, Lambda errors/throttles, worker errors/retries, and old queued work. Confirm SNS email subscription after deployment and verify delivery in issue #12.

Use `/usage` for a caller's UTC-day accepted inference units. The configured budget alerts at 80%/100% of the monthly amount for **the entire AWS account**, not just this stack. Budgets and API Gateway throttles are not hard cost caps. Daily admission limits, concurrency limits and request limits reduce exposure; they do not account for every AWS cost or retry.

## Retention and recovery

Job and alert access expires after `data_retention_days` (30 by default), even if DynamoDB TTL deletion has not yet occurred. S3 lifecycle expires source data, result chunks and exports according to each object's age; asynchronous deletion and later-written exports mean physical removal can lag job expiry. DynamoDB point-in-time recovery can retain historical copies beyond application expiry. Logs have separate retention. Alert-rule configuration remains until replaced; usage counters expire after three days.

Production table deletion protection and non-force-destroy S3 protect against accidental teardown. Restore data and state using account recovery procedures. Changes in retention apply to newly created metadata and the bucket's lifecycle policy; existing metadata is not rewritten automatically.

To roll back code, deploy a known reviewed commit against the same backend and environment, review the plan and run authenticated checks. Do not roll back across authentication or persisted-data contract changes without reviewing compatibility. Full rollback proof remains issue #12.
