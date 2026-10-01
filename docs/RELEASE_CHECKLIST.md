# Release verification checklist

Use this checklist for a deployable release of the sentiment API.

## Before apply

- Run `npm run lint` and `npm test`.
- Run Terraform format, initialization, and validation.
- Review the Terraform plan for unexpected IAM, API Gateway, Lambda, or log-retention changes.
- Confirm the production CORS origin is explicit rather than the development wildcard.
- Confirm the intended deployment identity is active.

## After apply

- Capture the Terraform `api_endpoint_url` output.
- Run `npm run smoke` against the deployed endpoint.
- Verify one successful request and one client-validation failure in CloudWatch Logs.
- Confirm the Lambda log group uses the intended retention period.
- Confirm the deployment summary points to the endpoint that was actually smoke-tested.

## Failure handling

If the smoke test fails after Terraform apply, do not treat the deployment as verified. Capture the failing request correlation details, review the Lambda/API Gateway logs, and either correct forward with a reviewed change or return to the previously known-good release.

## Teardown

For disposable environments, run a Terraform destroy plan using the same variable set used for apply. Review the plan before approval and confirm the API endpoint and Lambda are removed afterward.
