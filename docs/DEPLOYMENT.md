# Deployment and migration

Requirements: Terraform 1.10+ (CI uses 1.13.3), Node.js 24+, an AWS account, and a deployment identity allowed to manage this stack. Production deployment uses GitHub OIDC. No AWS resources are created by pull-request CI.

## 1. Persistent state

Use an existing private, encrypted, versioned S3 bucket, or create one once:

```bash
terraform -chdir=terraform/bootstrap init
terraform -chdir=terraform/bootstrap apply -var='state_bucket_name=YOUR_UNIQUE_BUCKET'
```

The bootstrap bucket is protected against destruction and has TLS enforcement, encryption, public-access blocking, and versioning. Its first apply uses local state. Preserve that bootstrap state; after creation, add `terraform/bootstrap/backend.tf` with `terraform { backend "s3" {} }` and migrate it using `init -migrate-state` to a separate key such as `bootstrap/state-bucket.tfstate` in the bucket. The environment backend must use a different key. Never commit state or credentials.

For the application:

```bash
npm ci
npm run build
cp terraform/backend.hcl.example terraform/backend.hcl
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit both files for your account, environment, origin, and notification recipient.
terraform -chdir=terraform init -backend-config=backend.hcl
terraform -chdir=terraform plan -out=release.tfplan
terraform -chdir=terraform apply release.tfplan
```

The S3 backend enables encryption and native lockfiles. The deployment role needs ListBucket for its prefix; GetObject/PutObject for the state object; and GetObject/PutObject/DeleteObject for the `.tflock` object. Do not disable locking to resolve contention. Use a unique key per region and environment, for example `sentiment-analysis/us-east-1/dev/terraform.tfstate`.

### Existing deployments

Back up the **current authoritative state** first. Run `terraform init -migrate-state -backend-config=backend.hcl` from the directory holding that state, then review a plan against the existing environment. Set `stage_name` explicitly: the new default is `dev`; old versions defaulted to `prod`. Do not change stage or project names during migration.

If earlier ephemeral runs lost the state, stop and recover it from the original machine/backups or import the existing resources. A fresh apply does not discover or adopt existing resources. Review the provider upgrade and the full plan before applying. The old single-request route keeps its Terraform address but switches to IAM authentication.

## 2. GitHub Actions

Create GitHub environments `dev`, `staging`, and `prod` as needed. Configure each environment's variables:

| Variable | Purpose |
| --- | --- |
| `AWS_ROLE_TO_ASSUME` | Deployment role ARN trusted through GitHub OIDC |
| `TF_STATE_BUCKET` | Existing versioned state bucket |
| `TF_STATE_REGION` | Bucket region; defaults to the selected deployment region |
| `NOTIFICATION_EMAIL` | Operator for CloudWatch and budget alerts |
| `CORS_ALLOWED_ORIGIN` | Browser origin; defaults to `*` |
| `MONTHLY_BUDGET_USD` | Account-wide monthly budget alert amount; defaults to 50 |

The workflow uses the selected GitHub environment, passes inputs through environment variables, serializes deployments by region/stage, initializes the persistent backend, saves a plan, and applies that exact plan. It has no access-key fallback. Configure production environment protection/review rules and an appropriate deployment branch policy in GitHub. The workflow itself cannot enforce repository settings.

See [AWS_OIDC.md](AWS_OIDC.md) for the trust boundary. The deployment role also needs permission to invoke the deployed API for the authenticated smoke test.

## 3. Consumers and notifications

Retrieve `consumer_invoke_policy` from Terraform and attach it to a dedicated consumer role. Sessions of the same role share one tenant; different customers must use different roles. Do not give consumers Lambda, S3, DynamoDB, or deployment permissions.

Confirm the SNS subscription sent to `notification_email`. Infrastructure alarms and budget notifications are provisioned, but email delivery is not active until confirmed. The budget monitors total account spending, across environments; it is an alert and does not halt spending. Sentiment thresholds are separate per-caller API alert feeds.

Run `API_ENDPOINT="$(terraform -chdir=terraform output -raw api_base_url)" npm run smoke` with an authorized identity. Full deployment/resilience/rollback proof is deferred to [#12](https://github.com/rclevenger-hm/sentiment_analysis_lambda/issues/12).

## Cleanup

Use the same backend and variables. Production DynamoDB deletion protection must be deliberately disabled before teardown. The private data bucket is not force-destroyed: archive/delete its objects deliberately first. Retain state bucket version history and protect bootstrap state; the bootstrap bucket has `prevent_destroy`. Review the destroy plan and any retained resources/costs.
