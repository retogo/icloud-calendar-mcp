# icloud-calendar-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets AI agents read and write your iCloud Calendar over CalDAV. It runs on Cloudflare Workers (the free plan is enough), so it works from Claude on the web, desktop, and mobile.

There is no shared public instance. You deploy your own copy to your Cloudflare account, and only you can authorize clients to use it.

> Not affiliated with or endorsed by Apple. iCloud is a trademark of Apple Inc.

## Tools

| Tool             | Description                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `list_calendars` | Lists calendars that hold events (Reminders lists are excluded)                                    |
| `list_events`    | Lists events in a period, with recurring events expanded and times given with their UTC offset     |
| `create_event`   | Creates a timed or all-day event                                                                   |
| `update_event`   | Changes the title, time, location, or description, keeping alarms, attendees, and recurrence rules |
| `delete_event`   | Deletes an event                                                                                   |

## Requirements

- A Cloudflare account
- An Apple Account with two-factor authentication
- [Bun](https://bun.sh), and [jq](https://jqlang.org) for `scripts/smoke.sh`

## Deploy

1. **Create an app-specific password.** Sign in at [account.apple.com](https://account.apple.com), open **Sign-In and Security → App-Specific Passwords**, and generate one. You can revoke it there at any time.

2. **Sign in to Cloudflare.** Deployment uses your Wrangler login, so no API token is needed:

   ```sh
   bun install
   bunx wrangler login
   ```

3. **Configure.** Copy the example secrets and fill them in. `AUTH_PASSWORD` is the password you will type on the consent page when connecting a client; use at least 16 characters.

   ```sh
   cp .dev.vars.example .dev.vars
   ```

4. **Deploy.** The first deploy uploads the secrets from `.dev.vars` and creates the KV namespace for OAuth state:

   ```sh
   bun run deploy --secrets-file .dev.vars
   ```

   The server is served at `https://icloud-calendar-mcp.<your-subdomain>.workers.dev/mcp`. Your `workers.dev` subdomain is shown on the Workers overview page of the dashboard.

`.dev.vars` is git-ignored and is also what `bun run dev` reads; keep it private. Later deploys keep the uploaded secrets and the KV namespace, so they need no flags. To change a secret, run `bunx wrangler secret put <NAME>`.

To update to a newer version:

```sh
git pull
bun install
bun run deploy
```

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
- `update_event` and `delete_event` act on a recurring event as a whole series; single occurrences cannot be changed or removed on their own.
- Recurring events that would take too many iterations to expand (for example, a rule repeating every second) are left out of `list_events` and reported in its `skipped` field.
- Workers Free allows 10 ms of CPU per request. Expanding a daily event that has repeated for decades can exceed it; the request then fails.
