# Integration guide

## What connects to what

The deployed request path is:

```text
client/service
    |
    | HTTPS POST /analyze-sentiment
    v
API Gateway
    |
    | Lambda proxy invocation
    v
AWS Lambda (Node.js 24)
    |
    | IAM-authenticated comprehend:DetectSentiment
    v
Amazon Comprehend
```

You do not need to create a Comprehend API key, hostname, database, queue, or model. The Lambda's IAM execution role authorizes the AWS SDK call to the regional Comprehend service. API Gateway is the public-facing integration point for your applications.

## Shell/cURL

```bash
export API_ENDPOINT="$(terraform -chdir=terraform output -raw api_endpoint_url)"

curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"The release went extremely well."}' \
  "$API_ENDPOINT"
```

## Node.js service

No SDK is required for a downstream service; call the HTTP endpoint with `fetch`:

```bash
export API_ENDPOINT="https://.../prod/analyze-sentiment"
node examples/node-client.mjs "The release went extremely well."
```

The example throws on non-2xx responses so it can be used directly in service/job error handling.

## Python service

The included example uses only the Python standard library:

```bash
export API_ENDPOINT="https://.../prod/analyze-sentiment"
python3 examples/python-client.py "The release went extremely well."
```

## Browser application

Terraform provisions an `OPTIONS` preflight method and the Lambda returns CORS response headers. Set `cors_allowed_origin` to the exact web application origin in production.

Open `examples/browser.html`, paste the deployed endpoint, and submit text to exercise the API from browser JavaScript.

Do not put AWS credentials in browser code. Browser applications should call API Gateway, not Amazon Comprehend directly.

## Postman / Insomnia / generated clients

Import `openapi.yaml`, then replace the `apiId`, `region`, and `stage` server variables using the deployed URL. This provides the request/response schemas and error statuses to client tooling.

## Calling Comprehend directly instead

If another trusted AWS workload already has IAM credentials, it can call `comprehend:DetectSentiment` directly with an AWS SDK. In that case this repository's API Gateway/Lambda layer is optional. Keep the API layer when you want a stable HTTP contract, centralized validation, browser access, or a boundary that prevents clients from receiving AWS credentials.

## Authentication and production hardening

The Terraform configuration intentionally defaults to an unauthenticated API (`authorization = "NONE"`) so the project works immediately after deployment. CORS does not secure the endpoint.

Before exposing a production endpoint broadly, choose an access-control model appropriate to the caller:

- **AWS IAM authorization** for AWS-to-AWS callers that can sign requests with SigV4;
- **Cognito/JWT authorizer** for end-user applications;
- **API Gateway API key + usage plan** for basic consumer identification/throttling (not a substitute for strong user authentication);
- **AWS WAF** for network/application filtering and abuse controls;
- a private/internal API architecture if the endpoint should never be public.

Those controls are environment-specific and are not enabled automatically because each changes how consumers authenticate.

## Timeouts and retries

Treat `502` as an upstream service failure. Callers may retry transient 5xx responses with bounded exponential backoff. Do not automatically retry 4xx responses; fix the request instead.

The Lambda timeout is 10 seconds. Downstream clients should use a finite request timeout slightly above their normal expected latency and should not retry indefinitely.
