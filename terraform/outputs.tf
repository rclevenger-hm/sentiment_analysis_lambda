output "api_endpoint_url" {
  description = "POST endpoint for sentiment analysis"
  value       = "https://${aws_api_gateway_rest_api.sentiment.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_api_gateway_stage.sentiment.stage_name}/analyze-sentiment"
}

output "api_gateway_rest_api_id" {
  description = "API Gateway REST API ID"
  value       = aws_api_gateway_rest_api.sentiment.id
}

output "lambda_function_name" {
  description = "Deployed Lambda function name"
  value       = aws_lambda_function.sentiment.function_name
}

output "lambda_log_group_name" {
  description = "CloudWatch Logs group for the Lambda function"
  value       = aws_cloudwatch_log_group.lambda.name
}


output "api_base_url" {
  value = aws_api_gateway_stage.sentiment.invoke_url
}
output "consumer_invoke_policy" {
  description = "Attach to each consumer's dedicated IAM role; role sessions share history and usage."
  value       = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "execute-api:Invoke", Resource = "${aws_api_gateway_rest_api.sentiment.execution_arn}/${var.stage_name}/*/*" }] })
}
output "data_bucket" { value = aws_s3_bucket.data.id }
output "operations_topic_arn" { value = aws_sns_topic.operations.arn }
