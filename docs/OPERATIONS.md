# Operations and troubleshooting

## Live verification

The repository includes an end-to-end smoke test:

```bash
API_ENDPOINT="$(terraform -chdir=terraform output -raw api_endpoint_url)" npm run smoke
```

It verifies the public API endpoint, API Gateway integration, Lambda execution, IAM permission, and a real Amazon Comprehend response.

## Lambda logs

Terraform outputs the CloudWatch log group name:

```bash
terraform -chdir=terraform output -raw lambda_log_group_name
```

Tail logs with the AWS CLI:

```bash
aws logs tail \
  "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --follow
```

The default retention period is 14 days and can be changed with `log_retention_days`.

## Verify Amazon Comprehend independently

For troubleshooting only, an AWS identity with `comprehend:DetectSentiment` can test the managed service directly:

```bash
aws comprehend detect-sentiment \
  --language-code en \
  --text "This service works well." \
  --region us-east-1
```

The Terraform-created Lambda role already has this permission; your local user/role only needs it if you run a direct CLI test or execute the Docker image locally with your own credentials.

## Common failures

### `403 Missing Authentication Token`

Usually means the API Gateway URL, stage, resource path, or HTTP method is wrong. Copy `api_endpoint_url` directly from Terraform and use `POST`.

### `400 Request body must contain valid JSON`

Send valid JSON and set `Content-Type: application/json`.

### `400 Unsupported languageCode`

Use one of the language codes documented in `docs/API.md`.

### `413 text must be 5000 UTF-8 bytes or fewer`

Split or truncate the input before sending it. The limit is inherited from Amazon Comprehend's synchronous `DetectSentiment` API.

### `502 Sentiment service unavailable`

Check the Lambda CloudWatch log. Common causes include a regional AWS service issue, an IAM-policy change, or an invalid runtime/service configuration. You can use the direct Comprehend CLI test above to distinguish an API/Lambda problem from a Comprehend/credential problem.

### Browser CORS error

Confirm `cors_allowed_origin` matches the browser application's scheme, hostname, and port. Re-run `terraform apply` after changing it. Use `*` only when broad cross-origin access is acceptable.

### Docker invocation cannot reach Comprehend

The local Lambda container needs AWS credentials that can call `comprehend:DetectSentiment`. Export or mount credentials using your normal AWS credential mechanism before starting the container.

## Costs

API Gateway, Lambda, CloudWatch Logs, and Amazon Comprehend are metered AWS services. Actual cost depends on request volume, text volume, logs, region, and account/free-tier eligibility. Review current AWS pricing before putting an unauthenticated endpoint on the public internet.

## Security notes

- The deployed POST method is unauthenticated by default.
- CORS is a browser policy, not authorization.
- The Lambda execution role is limited to `comprehend:DetectSentiment` plus standard Lambda logging permissions.
- Avoid storing AWS credentials in source code, Terraform variables, browser code, or the API request body.
- Prefer short-lived roles/OIDC for CI/CD when possible.
