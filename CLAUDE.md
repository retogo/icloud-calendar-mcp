# CLAUDE.md

Remote MCP server for iCloud Calendar on Cloudflare Workers. README.md is for users deploying it; this file is for working on the code.

## Layout

| Path                                | Role                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                      | Worker entry: `OAuthProvider` routes `/mcp` to the MCP handler and everything else to the consent page |
| `src/authorize.ts`                  | Consent flow: password check, rate limit, approve/deny                                                 |
| `src/consent-page.ts`               | Consent page HTML and its Content-Security-Policy                                                      |
| `src/mcp-server.ts`                 | MCP tool registration and input schemas (zod)                                                          |
| `src/tools.ts`                      | Tool logic, including the checks that keep URLs inside the owner's calendars                           |
| `src/caldav-client.ts`              | Minimal CalDAV client (PROPFIND / REPORT / PUT / DELETE)                                               |
| `src/multistatus.ts`, `src/ical.ts` | WebDAV multistatus XML and iCalendar parsing/building                                                  |
| `terraform/`                        | Deployment. Reads runtime settings from `wrangler.jsonc`                                               |
| `scripts/smoke.sh`                  | End-to-end check of OAuth and MCP against a running server                                             |

## Commands

```sh
bun run test        # unit tests (bun test, preload stubs cloudflare:workers)
bun run typecheck   # regenerates worker-configuration.d.ts, then tsc for src and tests
bun run lint        # biome + terraform fmt
bun run dev         # wrangler dev on :8787, secrets from .dev.vars (see .dev.vars.example)
bun run build       # bundle to dist/index.js for Terraform
```

Run test, typecheck, and lint before committing.

## Conventions

- Test-first: add a failing test in `tests/` before changing behavior.
- All code, comments, tests, tool descriptions, and UI text are in English.
- `wrangler.jsonc` is the single source for compatibility settings and the rate limit. When adding a binding, add it to both `wrangler.jsonc` (for `wrangler dev`) and `terraform/main.tf`.
- Commit messages use Conventional Commits (`feat:`, `fix:`, `chore:` …).

## Security invariants

Keep these covered by tests when touching the related code:

- Tools only act on URLs of the owner's calendars (`findCalendar`, `isEventOf` in `src/tools.ts`). This stops a client from sending the iCloud credentials to another host or deleting a whole calendar.
- iCalendar text escapes `\`, `;`, `,`, and every line break including a bare CR (`escapeText` in `src/ical.ts`).
- Event periods must be both dates or both offset date-times before they reach `buildEvent`.
- The consent page escapes every client-provided string, shows a logo only for a verified (CIMD) client when it is an `https:` URL on that client's domain, and is served with a CSP that allows no scripts.
- Authorization fails closed when `AUTH_PASSWORD` is shorter than 16 characters, and password attempts go through the rate limiter first.
