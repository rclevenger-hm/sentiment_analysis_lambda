# GitHub OIDC deployment path

The repository CI validates code, Terraform, and the container image without requiring AWS credentials. If deployment is added, use GitHub's OIDC federation rather than repository-stored access keys.

## Trust boundary

Create a dedicated AWS IAM role for this repository and environment. Its trust policy should accept GitHub's OIDC provider and constrain the `sub` claim to the intended repository and deployment environment or protected branch. Do not use a wildcard that permits every repository in the account.

The workflow should request only:

- `contents: read`
- `id-token: write`

and should receive AWS credentials only in the deployment job, after tests and Terraform validation have passed.

## Permission design

The deployment role should contain only the actions required by this Terraform stack. Start from the resources in `terraform/main.tf` and narrow permissions by service and, where AWS supports it, resource ARN. Avoid attaching `AdministratorAccess` for convenience.

Use a separate state backend and locking configuration before enabling unattended apply. CI should continue to run `terraform init -backend=false` and `terraform validate` for pull requests so review does not require cloud credentials.

## Deployment gate

A future deployment workflow should:

1. run the current Node, Terraform, and container checks;
2. obtain short-lived AWS credentials through OIDC;
3. run `terraform plan` and retain the plan as review evidence;
4. require an environment approval before apply;
5. verify the API health path after apply;
6. surface rollback instructions and the previous deployed revision.

## Verification

Before removing any legacy credential path, confirm in AWS CloudTrail that the role session was issued through the GitHub OIDC principal and that the workflow succeeds with no long-lived AWS secret configured in the repository.
