resource "aws_sns_topic" "operations" {
  name = "${local.name}-operations"
  tags = local.common_tags
}
resource "aws_sns_topic_subscription" "operator" {
  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.notification_email
}
resource "aws_sns_topic_policy" "operations" {
  arn = aws_sns_topic.operations.arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Principal = { Service = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"] },
    Action    = "sns:Publish", Resource = aws_sns_topic.operations.arn,
    Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
  }] })
}
resource "aws_budgets_budget" "account" {
  name         = "${local.name}-account-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  dynamic "notification" {
    for_each = toset([80, 100])
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.operations.arn]
    }
  }
  depends_on = [aws_sns_topic_policy.operations]
}
resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.name}-worker-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = concat([aws_sns_topic.operations.arn], var.alarm_action_arns)
  dimensions          = { FunctionName = aws_lambda_function.worker.function_name }
  tags                = local.common_tags
}
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.name}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  treat_missing_data  = "notBreaching"
  alarm_actions       = concat([aws_sns_topic.operations.arn], var.alarm_action_arns)
  dimensions          = { QueueName = aws_sqs_queue.jobs.name }
  tags                = local.common_tags
}
resource "aws_cloudwatch_log_metric_filter" "worker_failures" {
  name           = "${local.name}-worker-failures"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"worker_error\" }"
  metric_transformation {
    name          = "WorkerFailures"
    namespace     = local.name
    value         = "1"
    default_value = 0
  }
}
resource "aws_cloudwatch_metric_alarm" "worker_failures" {
  alarm_name          = "${local.name}-worker-retries"
  namespace           = local.name
  metric_name         = aws_cloudwatch_log_metric_filter.worker_failures.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = concat([aws_sns_topic.operations.arn], var.alarm_action_arns)
  tags                = local.common_tags
}
