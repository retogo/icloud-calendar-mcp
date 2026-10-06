# icloud-calendar-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets AI agents read and write your iCloud Calendar over CalDAV. It runs on Cloudflare Workers (the free plan is enough), so it works from Claude on the web, desktop, and mobile.

There is no shared public instance. You deploy your own copy to your Cloudflare account, and only you can authorize clients to use it.

> Not affiliated with or endorsed by Apple. iCloud is a trademark of Apple Inc.

## Tools

| Tool             | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `list_calendars` | Lists calendars that hold events (Reminders lists are excluded)   |
| `list_events`    | Lists events in a period, with recurring events expanded          |
| `create_event`   | Creates a timed or all-day event                                  |
| `delete_event`   | Deletes an event (a recurring event is deleted as a whole series) |

## Requirements

- A Cloudflare account
- An Apple Account with two-factor authentication
- [Bun](https://bun.sh), [Terraform](https://developer.hashicorp.com/terraform) 1.6 or later, and [jq](https://jqlang.org)

## Deploy

1. **Create an app-specific password.** Sign in at [account.apple.com](https://account.apple.com), open **Sign-In and Security → App-Specific Passwords**, and generate one. You can revoke it there at any time.

2. **Sign in to Cloudflare.** Deployment uses your Wrangler login, so no API token is needed:

   ```sh
   bun install
   bunx wrangler login
   ```

3. **Configure.** Copy the example variables and fill them in. `auth_password` is the password you will type on the consent page when connecting a client; use at least 16 characters.

   ```sh
   cp terraform/terraform.tfvars.example terraform/terraform.tfvars
   ```

4. **Deploy.**

   ```sh
   terraform -chdir=terraform init
   bun run plan     # preview the changes
   bun run deploy   # apply them
   ```

   Both build the Worker first and pass your Wrangler login to Terraform. For other Terraform commands, run `scripts/terraform.sh <command>`. In CI, set `CLOUDFLARE_API_TOKEN` and `TF_VAR_account_id` and they are used as is.

   The server is served at `https://icloud-calendar-mcp.<your-subdomain>.workers.dev/mcp`. Your `workers.dev` subdomain is shown on the Workers overview page of the dashboard.

`terraform.tfvars` and the Terraform state contain your secrets. Both are git-ignored; keep them private.

## Connect to Claude

Open **Settings → Connectors → Add custom connector** in Claude, enter your `/mcp` URL, and keep the detected defaults (sign in now, Claude's public identity). Click **Connect**, check that the consent page shows `claude.ai` as a verified client, enter your `auth_password`, and click **Allow**.

Connectors added on the web are also available in the Claude mobile apps.

## Verify a deployment

`scripts/smoke.sh` registers a test client, completes the OAuth flow, and calls `list_calendars`:

```sh
AUTH_PASSWORD=... scripts/smoke.sh https://icloud-calendar-mcp.<your-subdomain>.workers.dev
```

A `PROPFIND ... failed: 401` result means the iCloud credentials are wrong.

## How access is protected

- MCP clients must complete OAuth 2.1 (with Client ID Metadata Documents or Dynamic Client Registration). Only someone who knows `auth_password` can approve a client, and password attempts are rate-limited to 5 per minute.
- Your iCloud credentials stay in Worker secrets. Tools only accept URLs under your own calendars, so a client cannot redirect the credentials to another host.

## Limitations

- Reminders are not available over CalDAV and are not supported.
- Updating an existing event is not supported yet; delete and recreate it instead.
