variable "aws_region" {
  description = "AWS region in which to deploy the service"
  type        = string
  default     = "us-east-1"

  validation {
    condition     = trimspace(var.aws_region) != ""
    error_message = "aws_region must not be empty."
  }
}

variable "project_name" {
  description = "Base name used for AWS resources"
  type        = string
  default     = "sentiment-analysis"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.project_name))
    error_message = "project_name may contain only letters, numbers, underscores, and hyphens."
  }
}

variable "stage_name" {
  description = "API Gateway stage and deployment environment name"
  type        = string
  default     = "dev"

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

  validation {
    condition = contains([
      1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180,
      365, 400, 545, 731, 1096, 1827, 2192, 2557,
      2922, 3288, 3653,
    ], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs supported retention value."
  }
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


variable "daily_analysis_limit" {
  type        = number
  default     = 1000
  description = "Daily accepted inference units per IAM principal; targeted sentiment uses two units per record."
  validation {
    condition     = var.daily_analysis_limit >= 1 && floor(var.daily_analysis_limit) == var.daily_analysis_limit
    error_message = "daily_analysis_limit must be a positive integer."
  }
}
variable "data_retention_days" {
  type    = number
  default = 30
  validation {
    condition     = var.data_retention_days >= 1 && var.data_retention_days <= 365 && floor(var.data_retention_days) == var.data_retention_days
    error_message = "data_retention_days must be an integer from 1 to 365."
  }
}
variable "api_concurrency" {
  type    = number
  default = 10
  validation {
    condition     = var.api_concurrency >= 1 && floor(var.api_concurrency) == var.api_concurrency
    error_message = "api_concurrency must be a positive integer."
  }
}
variable "worker_concurrency" {
  type    = number
  default = 5
  validation {
    condition     = var.worker_concurrency >= 2 && floor(var.worker_concurrency) == var.worker_concurrency
    error_message = "worker_concurrency must be an integer of at least 2."
  }
}
variable "request_rate_limit" {
  type    = number
  default = 5
  validation {
    condition     = var.request_rate_limit > 0
    error_message = "request_rate_limit must be positive."
  }
}
variable "request_burst_limit" {
  type    = number
  default = 10
  validation {
    condition     = var.request_burst_limit >= 1 && floor(var.request_burst_limit) == var.request_burst_limit
    error_message = "request_burst_limit must be a positive integer."
  }
}
variable "notification_email" {
  type        = string
  description = "Operator email for CloudWatch and budget notifications. Confirm the SNS subscription after deployment."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.notification_email))
    error_message = "Set a valid notification_email."
  }
}
variable "monthly_budget_usd" {
  type        = number
  default     = 50
  description = "Account-wide monthly AWS cost notification threshold; this is not a hard spending cap."
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be positive."
  }
}
