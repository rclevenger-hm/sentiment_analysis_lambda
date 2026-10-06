mock_provider "aws" {}
mock_provider "archive" {}
variables {
  notification_email = "operator@example.com"
  stage_name         = "dev"
}
run "secure_service_plan" {
  command = plan
  assert {
    condition     = aws_api_gateway_method.post.authorization == "AWS_IAM" && aws_api_gateway_method.proxy.authorization == "AWS_IAM"
    error_message = "Every application route must require IAM authentication."
  }
  assert {
    condition     = aws_sqs_queue.jobs.visibility_timeout_seconds >= aws_lambda_function.worker.timeout * 6
    error_message = "SQS visibility timeout must cover Lambda processing and retries."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.jobs.function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "The queue consumer must report partial batch failures."
  }
  assert {
    condition     = aws_dynamodb_table.service.ttl[0].enabled && aws_dynamodb_table.service.point_in_time_recovery[0].enabled
    error_message = "Data retention and recoverability must be enabled."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.data.block_public_policy && aws_s3_bucket_public_access_block.data.restrict_public_buckets
    error_message = "Customer text must not be publicly accessible."
  }
  assert {
    condition     = aws_api_gateway_method_settings.limits.settings[0].throttling_rate_limit == 5
    error_message = "The gateway must enforce the configured request rate."
  }
}
run "protected_production_data" {
  command = plan
  variables { stage_name = "prod" }
  assert {
    condition     = aws_dynamodb_table.service.deletion_protection_enabled
    error_message = "Production job history must be protected from accidental deletion."
  }
}
