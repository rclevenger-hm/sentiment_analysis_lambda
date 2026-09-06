import json
import os
import sys
from urllib import request, error

endpoint = os.environ.get("API_ENDPOINT")
if not endpoint:
    raise SystemExit("Set API_ENDPOINT to the Terraform api_endpoint_url output.")

text = " ".join(sys.argv[1:]) or "This integration works well."
payload = json.dumps({"text": text, "languageCode": "en"}).encode("utf-8")
req = request.Request(
    endpoint,
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with request.urlopen(req, timeout=15) as response:
        print(json.dumps(json.load(response), indent=2))
except error.HTTPError as exc:
    body = exc.read().decode("utf-8")
    raise SystemExit(f"Sentiment API returned {exc.code}: {body}") from exc
