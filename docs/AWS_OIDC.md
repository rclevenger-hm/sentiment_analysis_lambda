# GitHub Actions to AWS with OIDC

The deployment workflow prefers short-lived AWS credentials issued through GitHub's OpenID Connect (OIDC) provider. Long-lived access-key secrets remain a compatibility fallback until the repository is migrated.

## Why this is safer

OIDC avoids storing an AWS access key and secret in GitHub. Each deployment requests a short-lived role session, and AWS evaluates the token against the role trust policy before credentials are issued.

The deployment role should be separate from Lambda runtime roles and should contain only the permissions Terraform needs to manage this stack.

## Repository configuration

1. Create or reuse the GitHub OIDC provider in the target AWS account:

   `https://token.actions.githubusercontent.com`

2. Create an IAM role for deployment with an explicit trust policy for this repository.
3. Add the role ARN as a GitHub Actions repository variable named `AWS_ROLE_TO_ASSUME`.
4. Run the manual deployment workflow and verify the `Configure AWS credentials with OIDC` step is used.
5. After several successful deployments, remove `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` repository secrets.

The workflow intentionally keeps the secret-based path as a migration fallback. When `AWS_ROLE_TO_ASSUME` is present, the access-key path is skipped.

## Example trust policy

Replace `<ACCOUNT_ID>` and tighten the `sub` condition to the branch/environment model you actually use.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:rclevenger-hm/sentiment_analysis_lambda:*"
        }
      }
    }
  ]
}
```

For a production deployment role, prefer a narrower subject such as a protected GitHub Environment or an explicitly approved branch rather than the broad repository pattern above.

## Validation checklist

Before deleting long-lived secrets:

- confirm the GitHub OIDC provider exists in the intended AWS account;
- confirm the role trust policy restricts tokens to this repository and the intended deployment context;
- confirm the role permission policy is scoped to resources Terraform manages;
- manually dispatch a deployment and verify AWS credentials are obtained through OIDC;
- verify Terraform apply and the live API smoke test both pass;
- verify CloudTrail records the expected `AssumeRoleWithWebIdentity` session;
- remove the access-key repository secrets only after the OIDC path is proven.

## Failure modes

### `Not authorized to perform sts:AssumeRoleWithWebIdentity`

Check the role trust policy's `aud` and `sub` conditions, and confirm the workflow has `id-token: write` permission.

### Workflow unexpectedly uses access keys

`AWS_ROLE_TO_ASSUME` is absent or empty. Configure the repository variable and rerun the workflow.

### Terraform receives credentials but AWS calls fail

The OIDC handshake succeeded; the deployment role permission policy is missing one or more required actions. Expand permissions only to the resource/action boundary demonstrated by Terraform rather than granting broad administrator access.

## Operational boundary

OIDC secures deployment identity; it does not make every Terraform change safe. Production deployments should still use reviewable Terraform plans, protected environments/approvals where appropriate, bounded IAM policies, and post-deploy smoke tests.
