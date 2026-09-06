# Security model

The default deployment is intentionally easy to exercise: API Gateway exposes the sentiment route without application authentication and Lambda calls Amazon Comprehend through IAM. That is appropriate for a demo/reference deployment, not a production Internet-facing trust boundary.

## Trust boundaries

```text
untrusted client
  -> API Gateway
  -> Lambda input validation
  -> IAM-authorized Comprehend call
  -> managed AWS service
```

Treat submitted text as potentially sensitive user data. Do not log full request bodies by default, and define data-classification/retention requirements before using the API for regulated or confidential content.

## Production hardening priorities

1. Require an authentication/authorization mechanism appropriate to the client: IAM/SigV4, JWT authorizer, Cognito, or another reviewed gateway authorizer.
2. Replace wildcard CORS with the exact browser origin where browser access is required.
3. Add API Gateway throttling/usage controls sized to both cost and Comprehend service quotas.
4. Consider AWS WAF for public Internet deployments that require abuse filtering beyond gateway throttles.
5. Keep Lambda IAM limited to the required Comprehend action and log permissions.
6. Prefer GitHub Actions OIDC + a short-lived deployment role over long-lived AWS access-key repository secrets.
7. Encrypt logs/state with the organization-required KMS controls when AWS defaults are insufficient.
8. Set explicit CloudWatch retention and alarms for elevated 4xx/5xx, Lambda errors/throttles, and latency.

## CI/CD credential model

The current manual deploy workflow supports long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets. For a production repository, create a narrowly scoped AWS deployment role that trusts GitHub's OIDC provider and restrict the trust policy to this repository/ref or protected environment.

The workflow should then request `id-token: write` and assume that role for the deployment job. Do not broaden the runtime Lambda role simply because the deployment role needs infrastructure permissions; those are separate trust boundaries.

## Abuse and cost controls

A public sentiment endpoint can be used to consume Lambda/API Gateway/Comprehend quota and cost. Authentication, request-size validation, rate limits, monitoring, and budget alarms should be designed together. A successful response is not evidence that a request should have been authorized.

## Incident response

If unexpected traffic or credential misuse is suspected:

- disable or restrict the public route/authorizer first;
- preserve API Gateway/Lambda/CloudTrail evidence;
- rotate/revoke any exposed deployment credential;
- inspect IAM changes and deployment history;
- quantify Comprehend/API usage and cost impact;
- restore service using the least-privilege reviewed configuration rather than relaxing controls to recover quickly.

## Security regression checklist

For changes touching Terraform, API Gateway, IAM, or CI:

- no wildcard IAM actions/resources unless technically required and documented;
- no committed AWS credentials or generated state containing secrets;
- no request-body logging added casually;
- CORS changes reviewed separately from authentication;
- public-route changes called out explicitly in the PR;
- Terraform plan and automated tests remain part of review before deployment.
