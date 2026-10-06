# GitHub OIDC deployment identity

The deployment workflow requires a short-lived role session through GitHub OIDC. Long-lived repository secrets are no longer used.

Create the GitHub OIDC provider in the AWS account if it does not already exist (`https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`). The trust policy for a role dedicated to production should follow this shape; replace the account and environment as appropriate:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:rclevenger-hm/sentiment_analysis_lambda:environment:prod"
      }
    }
  }]
}
```

The workflow specifies a GitHub environment, so its OIDC subject uses `environment:prod`, not `ref:refs/heads/main`. Restrict deployment branches and configure review protection on that GitHub environment. Use separate roles/environments for development and production. Do not use a repository-wide wildcard trust policy.

Set `AWS_ROLE_TO_ASSUME` on the matching GitHub environment. The role must manage the resources described by Terraform: API Gateway, Lambda, project IAM roles and policies, CloudWatch logs/alarms, EventBridge, DynamoDB, S3, SQS, SNS, and the budget. Scope resource-aware permissions to the project prefix; restrict `iam:PassRole` to the runtime roles and Lambda service. Review account-level permissions required by resource creation and budget management separately. The role also needs remote state/lock-object access and `execute-api:Invoke` on the service for the smoke test.

Runtime roles are separate: the API can perform single inference, create/read jobs, meter usage, and enqueue work. The worker can perform batch inference, checkpoint work, and recover stalled jobs. Consumers only invoke the API. Never grant consumers the deployment role.

Account-specific trust/permission configuration and live role verification are tracked in issue #12; the repository does not claim that an AWS role has already been provisioned or validated.
