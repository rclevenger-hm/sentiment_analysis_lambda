# AWS Lambda Sentiment Analysis

A deployable serverless sentiment-analysis API built with Amazon API Gateway, AWS Lambda, and Amazon Comprehend. It accepts text over HTTPS and returns the overall sentiment plus Comprehend confidence scores.

```text
client -> API Gateway -> Lambda -> Amazon Comprehend
                         |
                         -> CloudWatch Logs
```

Terraform provisions the complete AWS path: IAM permissions, log group, Lambda, API Gateway route, CORS preflight, deployment, and stage. Amazon Comprehend is a managed AWS API, so there is no separate Comprehend server, model, database, or API key to configure.

## Quick start

Requirements: AWS credentials, Terraform 1.6+, and Node.js 24+.

```bash
aws sts get-caller-identity
npm test
terraform -chdir=terraform init
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

Terraform prints the live endpoint as `api_endpoint_url`. Verify the entire deployed chain with a real Comprehend request:

```bash
API_ENDPOINT="$(terraform -chdir=terraform output -raw api_endpoint_url)" npm run smoke
```

Or call it directly:

```bash
curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"I love this product!","languageCode":"en"}' \
  "$(terraform -chdir=terraform output -raw api_endpoint_url)"
```

Example response:

```json
{
  "sentiment": "POSITIVE",
  "sentimentScore": {
    "Positive": 0.99,
    "Negative": 0.001,
    "Neutral": 0.009,
    "Mixed": 0
  }
}
```

## Documentation

- [Deployment guide](docs/DEPLOYMENT.md) — AWS prerequisites, Terraform, GitHub Actions, CORS, and teardown.
- [API reference](docs/API.md) — request/response contract, languages, limits, errors, and OpenAPI.
- [Integration guide](docs/INTEGRATION.md) — Node.js, Python, browser, Postman, AWS-to-AWS, and production authentication options.
- [Operations guide](docs/OPERATIONS.md) — smoke tests, CloudWatch logs, troubleshooting, security, and cost considerations.
- [OpenAPI contract](openapi.yaml) — importable API definition for API tooling/client generation.

Runnable clients are included in [`examples/`](examples/).

## Required AWS services

| Service | Purpose | Configuration in this repo |
| --- | --- | --- |
| API Gateway | Public HTTPS endpoint | Terraform creates route, stage, CORS preflight, and Lambda integration |
| Lambda | Validates input and calls Comprehend | Terraform deploys Node.js 24 handler |
| Amazon Comprehend | Performs sentiment inference | Lambda IAM role calls `DetectSentiment`; no resource/API key to create |
| IAM | Service-to-service authorization | Terraform creates Lambda role/policies |
| CloudWatch Logs | Lambda runtime/error logs | Terraform creates log group with 14-day default retention |

The public `POST` route is intentionally unauthenticated by default so a fresh deployment works immediately. See the integration guide before exposing it as a production public service.

## Local tests

The unit suite has no install step:

```bash
npm run lint
npm test
```

It covers success, CORS behavior, language selection, malformed JSON, missing input, oversized input, unsupported language, and Comprehend failure handling.

## Docker local Lambda runtime

The image uses the official AWS Lambda Node.js base image.

```bash
docker compose up --build
```

Invoke it through the Lambda Runtime Interface Emulator:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"body":"{\"text\":\"I love this product!\"}"}' \
  http://localhost:9000/2015-03-31/functions/function/invocations
```

A real Comprehend call from the local container requires AWS credentials with `comprehend:DetectSentiment`.

## Browser use / CORS

CORS preflight is provisioned automatically. Development defaults to `cors_allowed_origin = "*"`. For production browser clients, use the exact site origin:

```bash
terraform -chdir=terraform apply \
  -var='cors_allowed_origin=https://app.example.com'
```

See [`examples/browser.html`](examples/browser.html) for a minimal browser client.

## GitHub Actions

`CI` runs JavaScript checks/tests, Terraform format/init/validate, and a Docker image build.

`Deploy to AWS` is manually triggered and requires `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` repository secrets in its current form. It applies Terraform and then runs the live smoke test automatically. For production organizations, prefer GitHub Actions OIDC and an AWS deployment role; setup guidance is in the deployment guide.

## Cleanup

```bash
terraform -chdir=terraform destroy
```

## License

MIT. See [LICENSE](LICENSE).
