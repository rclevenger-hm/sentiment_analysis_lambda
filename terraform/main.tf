terraform {
  required_version = ">= 1.6.0"

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name = "${var.project_name}-${var.stage_name}"

  common_tags = {
    Application = var.project_name
    Environment = var.stage_name
    ManagedBy   = "Terraform"
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/../lambda_function/handler.js"
  output_path = "${path.module}/lambda_function.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "comprehend" {
  name = "${local.name}-comprehend"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = "comprehend:DetectSentiment"
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_days

  tags = local.common_tags
}

resource "aws_lambda_function" "sentiment" {
  function_name    = local.name
  description      = "Analyzes text sentiment with Amazon Comprehend"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  handler          = "handler.analyzeSentiment"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs24.x"
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      ALLOWED_ORIGIN = var.cors_allowed_origin
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.comprehend,
    aws_iam_role_policy_attachment.lambda_basic_execution,
  ]

  tags = local.common_tags
}

resource "aws_api_gateway_rest_api" "sentiment" {
  name        = "${local.name}-api"
  description = "HTTP API for sentiment analysis"

  tags = local.common_tags
}

resource "aws_api_gateway_resource" "analyze_sentiment" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  parent_id   = aws_api_gateway_rest_api.sentiment.root_resource_id
  path_part   = "analyze-sentiment"
}

resource "aws_api_gateway_method" "post" {
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  resource_id   = aws_api_gateway_resource.analyze_sentiment.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "lambda" {
  rest_api_id             = aws_api_gateway_rest_api.sentiment.id
  resource_id             = aws_api_gateway_resource.analyze_sentiment.id
  http_method             = aws_api_gateway_method.post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.sentiment.invoke_arn
}

resource "aws_api_gateway_method" "options" {
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  resource_id   = aws_api_gateway_resource.analyze_sentiment.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  resource_id = aws_api_gateway_resource.analyze_sentiment.id
  http_method = aws_api_gateway_method.options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = jsonencode({ statusCode = 200 })
  }
}

resource "aws_api_gateway_method_response" "options" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  resource_id = aws_api_gateway_resource.analyze_sentiment.id
  http_method = aws_api_gateway_method.options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "options" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id
  resource_id = aws_api_gateway_resource.analyze_sentiment.id
  http_method = aws_api_gateway_method.options.http_method
  status_code = aws_api_gateway_method_response.options.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.options]
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sentiment.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.sentiment.execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "sentiment" {
  rest_api_id = aws_api_gateway_rest_api.sentiment.id

  triggers = {
    redeployment = sha1(jsonencode({
      resource_id            = aws_api_gateway_resource.analyze_sentiment.id
      post_method_id         = aws_api_gateway_method.post.id
      post_integration_id    = aws_api_gateway_integration.lambda.id
      options_method_id      = aws_api_gateway_method.options.id
      options_integration_id = aws_api_gateway_integration.options.id
      cors_allowed_origin    = var.cors_allowed_origin
    }))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_integration.lambda,
    aws_api_gateway_integration_response.options,
  ]
}

resource "aws_api_gateway_stage" "sentiment" {
  deployment_id = aws_api_gateway_deployment.sentiment.id
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  stage_name    = var.stage_name

  tags = local.common_tags
}
