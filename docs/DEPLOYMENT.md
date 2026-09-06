# Deployment guide

This guide takes the service from a fresh AWS account/credential set to a live API endpoint.

## What gets created

Terraform creates:

- an IAM execution role for the Lambda function;
- a policy allowing only `comprehend:DetectSentiment` for the Lambda workload;
- a CloudWatch Logs group with configurable retention;
- a Node.js 24 Lambda function;
- an API Gateway REST API with `POST /analyze-sentiment`;
- an API Gateway `OPTIONS` method for browser CORS preflight;
- permission for API Gateway to invoke the Lambda function;
- an API Gateway deployment and stage.

Amazon Comprehend itself is a managed AWS API and does not need a separate Terraform resource. The Lambda calls Comprehend using its IAM role; there is no Comprehend API key to create or store.

## Prerequisites

Install:

- AWS CLI v2;
- Terraform 1.6+;
- Node.js 24+ for tests and smoke tests;
- Docker only if you want local Lambda-container execution.

Configure AWS credentials using your normal AWS mechanism. For example:

```bash
aws configure
aws sts get-caller-identity
```

The identity running Terraform must be able to manage the resources above: IAM roles/policies, Lambda, API Gateway, and CloudWatch Logs. In an organization, use an approved deployment role rather than a personal long-lived access key.

## Deploy locally with Terraform

From the repository root:

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit `terraform/terraform.tfvars` for your environment. For a browser-facing production app, replace the wildcard CORS origin with the exact application origin:

```hcl
aws_region          = "us-east-1"
project_name        = "sentiment-analysis"
stage_name          = "prod"
cors_allowed_origin = "https://app.example.com"
log_retention_days  = 14
```

Then:

```bash
npm test
terraform -chdir=terraform init
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

Get the endpoint:

```bash
terraform -chdir=terraform output -raw api_endpoint_url
```

Run a live end-to-end test through API Gateway, Lambda, and Comprehend:

```bash
API_ENDPOINT="$(terraform -chdir=terraform output -raw api_endpoint_url)" npm run smoke
```

## Deploy from GitHub Actions

The repository includes the manual `Deploy to AWS` workflow.

For the current access-key workflow, add these GitHub repository secrets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Open **Actions -> Deploy to AWS -> Run workflow**, then select the region, stage, and allowed CORS origin. The workflow runs tests, applies Terraform, retrieves the deployed endpoint, and performs a live Comprehend smoke test. The endpoint is written to the workflow summary.

For a production organization, prefer GitHub Actions OIDC with an AWS deployment role instead of long-lived AWS access keys. That requires an AWS IAM OIDC provider/trust policy specific to your GitHub repository and is intentionally not auto-created here because the trust boundary is account-specific.

## CORS

`cors_allowed_origin = "*"` is convenient for development. For a production browser application, set it to the exact origin, for example `https://app.example.com`.

CORS is not authentication. The API is unauthenticated by default, so any caller who knows the endpoint can invoke it.

## Destroy the environment

Use the same variables that were used during apply:

```bash
terraform -chdir=terraform destroy
```

Review the destroy plan before approving it.
