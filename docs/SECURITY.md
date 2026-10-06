# Security model

All application routes use API Gateway `AWS_IAM`; only OPTIONS preflight is public. Clients sign with SigV4. CORS is a browser access policy and does not replace IAM. Gateway request throttling and reserved Lambda concurrency are configured, and admission limits reserve inference units atomically per principal/UTC day.

The handler derives the tenant from API Gateway's authenticated IAM identity. It never accepts tenant IDs from request headers, body, paths, or filters. STS sessions of one role intentionally share a tenant, history, quota, and alert rule. Provision a dedicated IAM role per customer. A shared role does not provide isolation between its users. Principal unique IDs are preferred to prevent a recreated IAM identity inheriting prior data.

Consumers need only `execute-api:Invoke`. Direct invocation of the API Lambda is an administrative trust boundary: an identity with `lambda:InvokeFunction` can construct gateway-shaped events, so do not grant it to consumers. Likewise, the deployment and runtime roles must not be assumed by consumers. Worker invocations are restricted to the queue/scheduled service and administrators.

Source text is persisted only for bulk jobs. Private S3 uses encryption, blocked public access and TLS-only policy. DynamoDB stores metadata, usage, summaries and alert rules, with encryption, retention and point-in-time recovery. Short-lived export URLs grant access to exactly one object for 60 seconds; they must be protected as bearer credentials. CloudWatch logs do not include feedback text. See operations documentation for physical retention and backups.

Input validation includes object shape, UTF-8/base64 correctness, byte limits, language types, record counts, metadata sizes, CSV structure and unique record IDs. CSV exports neutralize spreadsheet formula prefixes. SDKs are packaged from a lockfile; no secrets or raw AWS errors are returned in application responses.

The deployment workflow uses environment-scoped OIDC, persisted/locked Terraform state, per-environment concurrency and a saved plan. Configure GitHub environment branch restrictions and protection rules; account-specific trust and least-privilege policies still require live verification in issue #12.

For an incident, restrict consumer invoke permissions or gateway access, preserve logs and state, inspect IAM/deployment history, and quantify usage before recovery. Do not relax IAM or disable locking to restore service. Keep sensitive customer text out of development fixtures.
