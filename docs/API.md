# API reference

The API exposes one operation.

## POST /analyze-sentiment

After Terraform deploys the stack, obtain the full URL with:

```bash
terraform -chdir=terraform output -raw api_endpoint_url
```

### Request

`Content-Type: application/json`

```json
{
  "text": "I love this product!",
  "languageCode": "en"
}
```

`text` is required, must not be blank, and must be at most 5 KB when UTF-8 encoded. `languageCode` is optional and defaults to `en`.

Supported language codes:

| Code | Language |
| --- | --- |
| `ar` | Arabic |
| `de` | German |
| `en` | English |
| `es` | Spanish |
| `fr` | French |
| `hi` | Hindi |
| `it` | Italian |
| `ja` | Japanese |
| `ko` | Korean |
| `pt` | Portuguese |
| `zh` | Chinese (Simplified) |
| `zh-TW` | Chinese (Traditional) |

### Success response

HTTP `200`:

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

`sentiment` is one of `POSITIVE`, `NEGATIVE`, `NEUTRAL`, or `MIXED`. The score values are the Comprehend confidence values for each category.

### Error responses

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, missing/blank text, or unsupported language code |
| `413` | UTF-8 input is larger than 5 KB |
| `502` | Lambda could not obtain a result from Amazon Comprehend |

Error body:

```json
{
  "error": "text must be a non-empty string"
}
```

### cURL

```bash
curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"I love this product!","languageCode":"en"}' \
  "$(terraform -chdir=terraform output -raw api_endpoint_url)"
```

## OpenAPI

`openapi.yaml` contains an OpenAPI 3.0 contract that can be imported into tools such as Postman, Insomnia, Swagger tooling, or client-generation pipelines. Replace its server variables with the values from your deployed endpoint.

## CORS

The API supports browser preflight (`OPTIONS`) and returns CORS headers on Lambda responses. Configure the allowed origin with Terraform's `cors_allowed_origin` variable. The default is `*` for development convenience.
