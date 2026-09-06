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
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.analyze_sentiment.id,
      aws_api_gateway_method.post.id,
      aws_api_gateway_integration.lambda.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration.lambda]
}

resource "aws_api_gateway_stage" "sentiment" {
  deployment_id = aws_api_gateway_deployment.sentiment.id
  rest_api_id   = aws_api_gateway_rest_api.sentiment.id
  stage_name    = var.stage_name

  tags = local.common_tags
}
