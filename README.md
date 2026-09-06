# AWS Lambda Sentiment Analysis

A small serverless API that accepts text over HTTP, analyzes it with Amazon Comprehend, and returns the detected sentiment and confidence scores. Terraform provisions the Lambda function, IAM permissions, API Gateway REST API, deployment, and stage.

## Architecture

`POST /analyze-sentiment` -> API Gateway -> AWS Lambda -> Amazon Comprehend

The Lambda runs on Node.js 24 and uses the AWS SDK for JavaScript v3 included with the managed Lambda runtime.

## Requirements

- Node.js 24 or newer for local tests
- Terraform 1.6 or newer
- AWS credentials with permission to create Lambda, IAM, API Gateway, and related resources
- Docker or Docker Compose only if you want to exercise the Lambda container locally

## Test locally

No npm dependencies are required for the unit tests.

```bash
npm test
npm run lint
```

The tests cover successful sentiment detection, language selection, invalid JSON, missing input, oversized input, unsupported languages, and upstream Comprehend failures.

## Deploy with Terraform

```bash
cd terraform
terraform init
terraform plan -var="aws_region=us-east-1" -var="stage_name=prod"
terraform apply -var="aws_region=us-east-1" -var="stage_name=prod"
```

Terraform prints `api_endpoint_url` after a successful apply.

## Call the API

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"I love this product!"}' \
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

You can optionally send `languageCode`; it defaults to `en`.

```json
{
  "text": "Me gusta este producto",
  "languageCode": "es"
}
```

## Run the Lambda container locally

The Docker image uses the official AWS Lambda Node.js base image. Export AWS credentials that are allowed to call Comprehend, then run:

```bash
docker compose up --build
```

Invoke the local Lambda runtime endpoint:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"body":"{\"text\":\"I love this product!\"}"}' \
  http://localhost:9000/2015-03-31/functions/function/invocations
```

## GitHub Actions

`CI` runs on pushes to `dev` and `main` and on pull requests to `main`. It checks JavaScript syntax, runs the unit tests, validates/formats Terraform, and verifies the Lambda container builds.

`Deploy to AWS` is a manual workflow. Add these repository secrets before using it:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Then run the workflow and choose the AWS region and API Gateway stage.

## Cleanup

```bash
terraform -chdir=terraform destroy
```

## License

MIT. See [LICENSE](LICENSE).
