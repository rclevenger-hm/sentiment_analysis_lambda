# Version 2.0

This release expands the single-text Lambda into an authenticated feedback analysis service.

- Persistent S3 Terraform backend with locking, versioned bootstrap bucket, isolated stage keys and serialized OIDC deployments.
- IAM-protected routes, per-principal daily admission limits, throttling/concurrency controls, and operator/budget notifications.
- Strict JSON/base64/UTF-8 validation and structured request errors.
- Idempotent CSV/JSON jobs, stable IDs, resumable 25-record processing, partial results, failure limits, scheduled recovery and exports.
- English targeted sentiment with traceable excerpts; job reports, filters, date trends and comparisons.
- Per-principal history and configurable threshold alert feeds with acknowledgement.
- Pinned/bundled SDK dependencies, behavioral tests and mock-provider infrastructure plans.

Breaking changes: unsigned requests are rejected; direct Lambda-shaped API invocations require trusted gateway identity; a remote backend and notification email are required for deployment; the deployment workflow requires OIDC and environment variables. Preserve/migrate existing Terraform state before applying.

Live AWS deployment, notification delivery, resilience and rollback verification are intentionally deferred to issue #12. No cloud deployment is implied by passing local or CI checks.
