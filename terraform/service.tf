data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  runtime_environment = {
    ALLOWED_ORIGIN       = var.cors_allowed_origin
    TABLE_NAME           = aws_dynamodb_table.service.name
    DATA_BUCKET          = aws_s3_bucket.data.id
    QUEUE_URL            = aws_sqs_queue.jobs.url
    DLQ_ARN              = aws_sqs_queue.failed.arn
    DAILY_ANALYSIS_LIMIT = tostring(var.daily_analysis_limit)
    DATA_RETENTION_DAYS  = tostring(var.data_retention_days)
  }
}

resource "aws_dynamodb_table" "service" {
  name                        = local.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "tenantId"
  range_key                   = "key"
  deletion_protection_enabled = var.stage_name == "prod"
  attribute {
    name = "tenantId"
    type = "S"
  }
  attribute {
    name = "key"
    type = "S"
  }
  attribute {
    name = "collectionId"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "S"
  }
  global_secondary_index {
    name            = "timeline"
    hash_key        = "collectionId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = local.common_tags
}

resource "aws_s3_bucket" "data" {
  bucket_prefix = "${local.name}-"
  force_destroy = false
  tags          = local.common_tags
}
resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    id     = "retention"
    status = "Enabled"
    filter { prefix = "" }
    expiration { days = var.data_retention_days }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
resource "aws_s3_bucket_policy" "data" {
  bucket = aws_s3_bucket.data.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}

resource "aws_sqs_queue" "failed" {
  name                       = "${local.name}-failed"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 720
  sqs_managed_sse_enabled    = true
  tags                       = local.common_tags
}
resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-jobs"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.failed.arn, maxReceiveCount = 5 })
  tags                       = local.common_tags
}
resource "aws_sqs_queue_redrive_allow_policy" "failed" {
  queue_url            = aws_sqs_queue.failed.id
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.jobs.arn] })
}

resource "aws_iam_role_policy" "api_storage" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"], Resource = [aws_dynamodb_table.service.arn, "${aws_dynamodb_table.service.arn}/index/*"] },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.data.arn}/*" },
    { Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.jobs.arn }
  ] })
}
resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = aws_iam_role.lambda.assume_role_policy
  tags               = local.common_tags
}
resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["comprehend:BatchDetectSentiment", "comprehend:BatchDetectTargetedSentiment"], Resource = "*" },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"], Resource = [aws_dynamodb_table.service.arn, "${aws_dynamodb_table.service.arn}/index/*"] },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.data.arn}/*" },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.jobs.arn, aws_sqs_queue.failed.arn] },
    { Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.jobs.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.worker.arn}:*" }
  ] })
}
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name}-worker"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}
resource "aws_lambda_function" "worker" {
  function_name                  = "${local.name}-worker"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  handler                        = "worker.handler"
  role                           = aws_iam_role.worker.arn
  runtime                        = "nodejs24.x"
  timeout                        = 120
  memory_size                    = 512
  reserved_concurrent_executions = var.worker_concurrency + 1
  environment { variables = local.runtime_environment }
  depends_on = [aws_iam_role_policy.worker]
  tags       = local.common_tags
}
resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn        = aws_sqs_queue.jobs.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = var.worker_concurrency }
}
resource "aws_lambda_event_source_mapping" "failed" {
  event_source_arn        = aws_sqs_queue.failed.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
resource "aws_cloudwatch_event_rule" "recovery" {
  name                = "${local.name}-recovery"
  schedule_expression = "rate(15 minutes)"
  tags                = local.common_tags
}
resource "aws_cloudwatch_event_target" "recovery" {
  rule = aws_cloudwatch_event_rule.recovery.name
  arn  = aws_lambda_function.worker.arn
}
resource "aws_lambda_permission" "recovery" {
  statement_id  = "AllowScheduledRecovery"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.recovery.arn
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  parent_id   = aws_api_gateway_rest_api.sentiment.root_resource_id
  path_part   = "{proxy+}"
}
resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "AWS_IAM"
}
resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.sentiment.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.sentiment.invoke_arn
}
resource "aws_api_gateway_method" "proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}
resource "aws_api_gateway_integration" "proxy_options" {
  rest_api_id       = aws_api_gateway_rest_api.sentiment.id
  resource_id       = aws_api_gateway_resource.proxy.id
  http_method       = aws_api_gateway_method.proxy_options.http_method
  type              = "MOCK"
  request_templates = { "application/json" = jsonencode({ statusCode = 200 }) }
}
resource "aws_api_gateway_method_response" "proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}
resource "aws_api_gateway_integration_response" "proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_options.http_method
  status_code = aws_api_gateway_method_response.proxy_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token,X-Amz-Content-Sha256,Idempotency-Key'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }
  depends_on = [aws_api_gateway_integration.proxy_options]
}
resource "aws_api_gateway_gateway_response" "cors" {
  for_each      = toset(["DEFAULT_4XX", "DEFAULT_5XX"])
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  response_type = each.value
  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token,X-Amz-Content-Sha256,Idempotency-Key'"
  }
}
resource "aws_api_gateway_method_settings" "limits" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  stage_name  = aws_api_gateway_stage.sentiment.stage_name
  method_path = "*/*"
  settings {
    throttling_rate_limit  = var.request_rate_limit
    throttling_burst_limit = var.request_burst_limit
    metrics_enabled        = true
  }
}
