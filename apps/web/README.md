# ProofServe Web

The Web app proxies browser agent-run requests through a narrow server route.
Configure these server-only variables in the Web deployment:

- `AGENT_RUN_API_ORIGIN`: the absolute HTTP(S) origin of the ProofServe API.
  It must contain no path, query, credentials, or fragment. When omitted, the
  route uses `REGISTRY_API_ORIGIN`, then `http://127.0.0.1:3001`. Non-loopback
  origins must use HTTPS so the server bearer token is not sent over cleartext.
- `AGENT_RUN_API_TOKEN`: the same 32–512 character, whitespace-free bearer token
  configured on the API. Never prefix it with `NEXT_PUBLIC_` or expose it to
  browser code.
- `AGENT_RUN_WEB_ACCESS_TOKEN`: a separate 16–256 character demo access code.
  Give this code only to authorized demo users. They enter it on the page; the
  Web boundary validates it and never forwards it upstream. Do not reuse an API,
  Hedera, registry, or service credential for this value.
- `AGENT_RUN_CAPABILITY_SECRET`: a dedicated 32–512 character, whitespace-free
  server secret used to authenticate short-lived, run-specific browser sessions.
  It must differ from both tokens above and must never use a `NEXT_PUBLIC_`
  prefix. Rotating it immediately invalidates outstanding run sessions.

Serve the Web app over HTTPS. Rotate the demo access code if it is disclosed;
holders can start server-funded testnet runs. Apply deployment-level request
rate limits appropriate for the available testnet balance.

After creation, the Web server sets a 30-minute, `HttpOnly`, `SameSite=Strict`
cookie bound to only the new run ID. Its `/api/agent/runs/` path includes item
status routes but excludes the collection creation route. Status retrieval
requires that session cookie as well as the demo access code, so knowing another
run ID and the shared code is insufficient to retrieve it. Creating another run
in the same browser replaces the cookie and rotates the session to the new run.
Like any browser session cookie, it has bearer-session semantics if an attacker
obtains the raw cookie despite the `HttpOnly`, same-site, HTTPS, and path
restrictions.
Creation is never automatically retried because an unavailable response can
still mean the server accepted and paid the run. Transient status failures use
bounded backoff; an authorization or run-session failure permanently stops local
automatic polling so cookie expiry or cross-tab rotation cannot create a request
loop. The route accepts only `POST /api/agent/runs` and
`GET /api/agent/runs/:runId`, validates bounded JSON against the shared schemas,
binds responses to the request, strips upstream headers and diagnostics, and
returns `Cache-Control: no-store`.
