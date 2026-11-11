# src/net — destination safety

Stops the SDK from opening connections to the device owner's local network.

## destination-check.ts

| Export | Use |
|---|---|
| `checkDestination(url, { mode })` | Full check of a URL: scheme (http/https), port, localhost names, IP literals, then DNS. Resolves to `{ host, port, address, family, addresses }`. |
| `checkHostPort(host, port, { mode })` | Same for a bare host and port, when there is no URL. |
| `precheckUrl(url, mode)` | Synchronous part only (no DNS). |
| `resolveAndCheck(host)` | DNS part only: every A/AAAA address must be public. |
| `isBlockedAddress(ip)` | True for any non-public IP literal. Invalid input is treated as blocked. |
| `DestinationBlockedError` | `code: 'EGRESS_BLOCKED'`, `reason`, `host`. Never contains the resolved address. |

Modes and allowed ports:

| Mode | Ports | Used by |
|---|---|---|
| `fetch` | 80, 443 | `parser_job`, `method_endpoint` |
| `tls` | 443 | callers that only need HTTPS (not used by the job paths) |

Blocked: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`,
`192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `::/96`, `64:ff9b:1::/48`,
`100::/64`, `2001::/32`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, plus
IPv4 carried in IPv6 (`::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`) when the embedded address is blocked,
and the names `localhost` / `*.localhost`.

**Rule for callers:** connect to the `address` the check returned. Never resolve the name again
before connecting, or DNS rebinding can swap in a private address.

## safe-fetch.ts

`safeFetch(url, init)` is a drop-in for `fetch` in the job paths.

- The check runs inside the connection's own DNS lookup, so the address checked is the address
  connected (one resolution per new connection, no rebinding window).
- TLS SNI, certificate hostname check and `Host` keep the original name; certificate validation is
  unchanged.
- Redirects are followed here, max 20 like `fetch`, and every hop is checked again. Method, body
  and header rewriting follow the fetch spec (302/303 POST → GET; 307/308 keep; `Authorization`,
  `Cookie` dropped cross-origin).
- Policy refusals throw `DestinationBlockedError` (`isEgressBlocked(err)` is true). DNS failures
  and other network errors throw `TypeError('fetch failed')` with the original cause, like `fetch`.

`createSafeFetch({...})` takes test-only seams (resolver, address rule, ports, CA). Production code
uses `safeFetch`, which always applies the real rules.

## Tests

- `npm test`: unit and integration (`test/net`). Includes real-network cases; `NET_TESTS=0` skips them.
- `npm run test:perf`: load, CPU, accelerated soak and failure tests (`test/perf`).
  `SOAK_MINUTES=60` adds a real-rate paced soak. `PERF_OUT=file.json` writes a summary.
- `npm run test:electron`: builds, runs the unit suite on Electron's runtime (`ELECTRON_RUN_AS_NODE=1`),
  then `test/electron/main-smoke.cjs` inside a real Electron main process (needs network).
  Note: VS Code terminals export `ELECTRON_RUN_AS_NODE=1`; the smoke step unsets it.

## Job paths using it

`src/utils/job-fetch.ts`: `fetchParserContent` (`parser_job`) and `makeFetchRequest` (`method_endpoint`,
re-exported from `data-helpers.ts`). A refusal is reported as job error code `EGRESS_BLOCKED` with
`raw: { reason, host, ... }` — never the resolved address. DNS and network failures keep their old
codes (`PARSER_FETCH_FAILED`, `FETCH_FAILED`).
