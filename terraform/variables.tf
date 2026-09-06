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
