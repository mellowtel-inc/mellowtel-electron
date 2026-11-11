# src/net — destination safety

Stops the SDK from opening connections to the device owner's local network.

## destination-check.ts

| Export | Use |
|---|---|
| `checkDestination(url, { mode })` | Full check of a URL: scheme (http/https), port, localhost names, IP literals, then DNS. Resolves to `{ host, port, address, family, addresses }`. |
| `checkHostPort(host, port, { mode })` | Same for a bare host and port, for example a proxy `OPEN` frame. |
| `precheckUrl(url, mode)` | Synchronous part only (no DNS). |
| `resolveAndCheck(host)` | DNS part only: every A/AAAA address must be public. |
| `isBlockedAddress(ip)` | True for any non-public IP literal. Invalid input is treated as blocked. |
| `DestinationBlockedError` | `code: 'EGRESS_BLOCKED'`, `reason`, `host`. Never contains the resolved address. |

Modes and allowed ports:

| Mode | Ports | Used by |
|---|---|---|
| `fetch` | 80, 443 | `parser_job`, `method_endpoint` |
| `proxy` | 443 | proxy tunnel (`src/proxy/`, not built yet) |

Blocked: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`,
`192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `::/96`, `64:ff9b:1::/48`,
`100::/64`, `2001::/32`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, plus
IPv4 carried in IPv6 (`::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`) when the embedded address is blocked,
and the names `localhost` / `*.localhost`.

**Rule for callers:** connect to the `address` the check returned. Never resolve the name again
before connecting, or DNS rebinding can swap in a private address.
