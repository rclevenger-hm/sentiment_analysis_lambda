variable "aws_region" {
  description = "AWS region in which to deploy the service"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Base name used for AWS resources"
  type        = string
  default     = "sentiment-analysis"
}

variable "stage_name" {
  description = "API Gateway stage and deployment environment name"
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.stage_name))
    error_message = "stage_name may contain only letters, numbers, underscores, and hyphens."
  }
}

variable "cors_allowed_origin" {
  description = "Browser origin allowed by CORS. Use * for development or a specific https:// origin for production."
  type        = string
  default     = "*"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period for Lambda logs"
  type        = number
  default     = 14
}

variable "alarm_action_arns" {
  description = "Optional action ARNs invoked when service-health CloudWatch alarms enter ALARM state, such as an SNS topic."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.alarm_action_arns : can(regex("^arn:[^:]+:[^:]+:[^:]*:[^:]*:.+$", arn))])
    error_message = "alarm_action_arns must contain valid ARN-shaped values."
  }
}
