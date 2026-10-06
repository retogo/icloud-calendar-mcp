variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "worker_name" {
  description = "Name of the Worker, used in its workers.dev URL"
  type        = string
  default     = "icloud-calendar-mcp"
}

variable "icloud_username" {
  description = "Apple Account email address"
  type        = string
  sensitive   = true
}

variable "icloud_app_password" {
  description = "App-specific password generated at account.apple.com"
  type        = string
  sensitive   = true
}

variable "auth_password" {
  description = "Password entered on the consent page when connecting an MCP client"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.auth_password) >= 16
    error_message = "auth_password must be at least 16 characters."
  }
}
