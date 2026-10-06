"""Signed example. Install boto3 and set API_ENDPOINT/AWS_REGION or a profile."""
import json
import os
import sys
import urllib.request
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

session = boto3.Session()
endpoint = os.environ['API_ENDPOINT'].rstrip('/').removesuffix('/analyze-sentiment')
body = json.dumps({'text': ' '.join(sys.argv[1:]) or 'This service works well.'}).encode()
request = AWSRequest(method='POST', url=endpoint + '/analyze-sentiment', data=body,
                     headers={'Content-Type': 'application/json'})
SigV4Auth(session.get_credentials().get_frozen_credentials(), 'execute-api',
          session.region_name or 'us-east-1').add_auth(request)
http = urllib.request.Request(request.url, data=body, headers=dict(request.headers), method='POST')
with urllib.request.urlopen(http, timeout=35) as response:
    print(response.read().decode())
