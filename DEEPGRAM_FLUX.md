# Deepgram Flux (AU) — Design Decisions & Operations

This document covers the `deepgramFlux` custom STT vendor (`lib/stt/deepgramFlux.js`):
why it's built the way it is, and how to access/debug the droplet it currently
runs on. See `DEVELOPER_GUIDE.md` for the general VG custom-speech contract
this vendor implements against, and `HANDOVER.md` for the original scope of
this repo.

## Design decisions

### Hosting: a plain Droplet, not App Platform

App Platform was tried first and abandoned. Its public ingress is always
Cloudflare-fronted and dual-stack (both A and AAAA records), and there is no
per-app way to disable IPv6. Voice Gateway's credential validation rejects any
custom-STT URL that resolves to an IPv6 address at all. Attaching a
self-managed custom domain doesn't avoid this either — App Platform's domain
automation insists on a CNAME to its (dual-stack) default ingress whenever the
domain's DNS zone is also owned by the same DigitalOcean account, and a CNAME
to a dual-stack target still resolves dual-stack.

A plain Droplet has none of this: a single IPv4 address by default, IPv6 only
if explicitly requested (it wasn't). DNS is a direct `A` record with no `AAAA`
record anywhere in the chain, confirmed via `dig` against the authoritative
nameserver.

A DigitalOcean support ticket is open to ask whether App Platform can (a) have
IPv6/dual-stack ingress disabled, and (b) get Scale to Zero / Inactivity Sleep
enabled on this account (it's currently gated behind private preview — DO's
own API returned "Inactivity sleep is not enabled for your account" when
tried). If either comes back favorable, App Platform may be worth revisiting
for cost reasons — ticket:
<https://cloudsupport.digitalocean.com/s/case-detail?recordId=500QP00001jiobNYAQ>.

### DNS

`vg.nice-agentic.com` → a single `A` record in DigitalOcean's own DNS
zone for `nice-agentic.com`, pointing at the droplet's IP. No `AAAA` record.
(An earlier attempt delegated this subdomain to Hetzner via NS records, as a
workaround for App Platform's forced-CNAME behaviour — that delegation was
removed once the project moved to a Droplet, since it was no longer needed.)

### TLS

Caddy in front of the Node app, reverse-proxying to `localhost:3000`.
Automatic Let's Encrypt certificate via HTTP-01 challenge — no manual cert
management. WebSocket upgrades pass through a plain `reverse_proxy` directive
with no special config; Caddy handles the Upgrade/Connection headers itself.

### Auth: pass-through, not a stored key

Most other STT vendors in this repo (`google.js`, `gladia.js`, etc.) read a
static `*_API_KEY` env var. `deepgramFlux.js` does not. Instead, the
`Authorization: Bearer <token>` header VG sends when opening the WebSocket
connection is extracted in `app.js` and threaded through to the vendor module,
which forwards it to Deepgram unchanged as `Authorization: Token <token>`.

This means whoever configures the VG custom-STT credential enters their real
Deepgram API key as the connection's Bearer token — this server never owns or
stores a Deepgram key itself. It also means the server's own `API_KEY` env var
(used by `app.js`'s `isValidApiKey` gate on the WebSocket upgrade) must be set
to that same Deepgram key, since it does double duty as both the upgrade gate
and the forwarded upstream credential. **When the Deepgram key rotates, update
it in both places**: the droplet's `custom-speech.service` (`API_KEY=`) and
the VG credential config.

### Turn-event mapping

Flux's turn model doesn't map 1:1 onto VG's `is_final` contract
(`DEVELOPER_GUIDE.md`'s rule: a turn ends only when VG receives
`is_final: true`, and `stop` is teardown-only, never a "finalize now" signal).

| Flux `TurnInfo.event` | Forwarded to VG as |
|---|---|
| `EndOfTurn` | `is_final: true` — the only event treated as authoritative |
| `Update` | `is_final: false`, only if VG requested `interimResults` |
| `EagerEndOfTurn` | `is_final: false`, only if `interimResults` — **not** `true`, since it's only "moderate confidence" and can be reversed |
| `TurnResumed` | Not forwarded — confirms a prior `EagerEndOfTurn` was premature |
| `StartOfTurn` | Not forwarded — carries no transcript update worth sending |

Sending `EagerEndOfTurn` as `is_final: true` would end VG's listening turn
mid-utterance, since VG has no endpointing of its own and trusts our
`is_final: true` completely.

### Model & language

- Model is hardcoded to `flux-general-en` (`MODEL` constant in
  `deepgramFlux.js`). `flux-general-multi` is not currently used.
- `language_hint` is **only** sent when `MODEL === 'flux-general-multi'`.
  Deepgram rejects `language_hint` outright (`400 INVALID_QUERY_PARAMETER`)
  on `flux-general-en` — confirmed via a live test call.
- The `language` value VG sends (e.g. `en-AU`, or free text like `English` in
  earlier tests) is passed through verbatim into our outgoing `transcription`
  messages' `language` field, but never used to drive Deepgram behaviour while
  the model stays `flux-general-en`.

### The `customOptions` gap and the `__fluxcfg:` hints workaround

Cognigy's `transcribe` verb reference documents a `recognizer.customOptions`
field for arbitrary vendor-specific options. In practice, **it never reaches
this server** — confirmed empirically across many repeated live test calls,
with multiple field-name/nesting variants (`customParam` nested,
`customOptions` nested, `customOptions` at the top level alongside
`recognizer`). Every test showed only `recognizer.hints` and
`recognizer.hintsBoost` arriving in the `start` message's `options` object;
custom keys were silently dropped every time. The Cognigy Flow-node UI
(`Set Session Config` / `Session Speech Parameters Config`) doesn't expose a
"custom options" field at all — only `STT Hints` / `Dynamic Hints` — so this
may simply not be wired up on the Flow-node path, only on VG's raw
`dial`/`listen` verb API.

Since `recognizer.hints` **does** reach us reliably, it's used as a stopgap
channel for other Flux settings. A hint entry shaped like
`"__fluxcfg:<key>=<value>"` is intercepted and applied as a Flux query-param
override instead of being forwarded as a real keyterm. Everything else in the
`hints` array still goes to Deepgram unchanged as `keyterm`.

The `__fluxcfg:` prefix and a strict key whitelist (`FLUXCFG_PARSERS` in
`deepgramFlux.js`) exist specifically to avoid colliding with a genuine hint
word that happens to contain `=` or look similar. Unknown keys and invalid
values are rejected and logged, not silently ignored.

**This is a stopgap, not a real fix.** Revisit and remove once `customOptions`
passthrough is fixed or clarified on the VG side.

Example payload (values shown are Deepgram's own defaults, so this is a no-op
unless you change them):

```json
{
  "recognizer": {
    "vendor": "custom:Custom Spike",
    "language": "en-AU",
    "hints": [
      "__fluxcfg:eot_threshold=0.7",
      "__fluxcfg:eot_timeout_ms=5000",
      "help",
      "skip",
      "confirm"
    ]
  }
}
```

### Full parameter wiring status

| Param | Wired? | What "omitted" means |
|---|---|---|
| `model` | Hardcoded, not overridable | Always `flux-general-en` |
| `encoding` | Passthrough from VG `start.encoding` | Whatever VG sends (currently `linear16`) |
| `sample_rate` | Passthrough from VG `start.sampleRateHz` | Whatever VG sends (currently `8000`) |
| `keyterm` | Real (non-`__fluxcfg:`) entries in `recognizer.hints` | No keyterm boosting if `hints` is empty/absent |
| `eot_threshold` | `__fluxcfg:eot_threshold=<v>` | Deepgram default `0.7` |
| `eot_timeout_ms` | `__fluxcfg:eot_timeout_ms=<v>` | Deepgram default `5000` |
| `language_hint` | Coded but dormant (only sent for `flux-general-multi`) | No effect while model is `flux-general-en` |
| `profanity_filter` | Not wired | Deepgram default `false` |
| `numerals` | Not wired | Deepgram default `false` |
| `redact` | Not wired | No redaction |
| `eager_eot_threshold` | Not wired | Deepgram's internal default (not documented explicitly) |
| `tag` | Not wired | No tag attached |
| `mip_opt_out` | Not wired | Not documented explicitly — check Deepgram account settings if this matters |

## Operations

### Accessing the Droplet

- **IP**: `134.199.159.44`
- **Region**: `syd1` (Sydney)
- **SSH**: `ssh root@134.199.159.44` (key-based auth via whichever SSH key is
  loaded in your agent and registered against this droplet)
- **App code**: `/opt/app`, a clone of this repo. Currently checked out on
  `feat/deepgram-flux-stt`.
- **Public endpoint**: `wss://vg.nice-agentic.com/transcribe/deepgramFlux`

### Deploying a change

```bash
ssh root@134.199.159.44 "cd /opt/app && git pull origin <branch> && npm install && systemctl restart custom-speech"
```

### Services

| Service | Purpose | Config |
|---|---|---|
| `custom-speech.service` | The Node app itself | `/etc/systemd/system/custom-speech.service` — runs `node /opt/app/app.js`, env vars `API_KEY` and `HTTP_PORT=3000` |
| `caddy` | TLS termination + reverse proxy | `/etc/caddy/Caddyfile` — proxies `vg.nice-agentic.com` to `localhost:3000` |

Restart either with `systemctl restart <service>`; check status with
`systemctl status <service> --no-pager`.

### Logs / debugging

```bash
# App logs (JSON, one line per log event via pino)
ssh root@134.199.159.44 "journalctl -u custom-speech --no-pager --since '10 minutes ago'"

# Live tail
ssh root@134.199.159.44 "journalctl -u custom-speech -f"

# Caddy logs (TLS/cert issuance, proxy errors)
ssh root@134.199.159.44 "journalctl -u caddy --no-pager --since '10 minutes ago'"
```

Useful things to grep for in app logs:

- `upgraded to websocket, url: ...` — confirms which vendor path a call hit
  (e.g. catches a VG credential still pointed at `/transcribe/test` instead of
  `/transcribe/deepgramFlux`)
- `received JSON message from Cognigy Voice Gateway` — every `start`/`stop`
  from VG, including the full `options` object as received
- `deepgramFlux: connecting to Deepgram Flux` — logs the exact constructed
  Flux URL, including any `keyterm`/`eot_threshold`/`eot_timeout_ms` query
  params, so you can see exactly what was sent upstream
- `deepgramFlux: applied __fluxcfg override from hints` /
  `unknown __fluxcfg key, ignoring` / `invalid __fluxcfg value, ignoring` —
  confirms whether a `__fluxcfg:` hint was actually parsed and accepted
- `deepgramFlux: received message from Deepgram Flux` — every message from
  Flux itself, including `TurnInfo` events with `transcript`/`event`/
  `end_of_turn_confidence` — this is the fastest way to see whether real
  speech is being transcribed and whether `EndOfTurn` fired
- `invalid auth header: Bearer ...` (from `app.js`) — the WS upgrade was
  rejected before reaching any vendor module; almost always means the VG
  credential's Bearer token doesn't match the droplet's `API_KEY`

### Testing a connection manually (without a VG call)

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://vg.nice-agentic.com/transcribe/deepgramFlux', {
  headers: {Authorization: 'Bearer <the current API_KEY / Deepgram key>'}
});
ws.on('open', () => {
  ws.send(JSON.stringify({type:'start', language:'en-AU', format:'raw', encoding:'LINEAR16', interimResults:true, sampleRateHz:8000, options:{}}));
});
ws.on('message', (data) => console.log('MSG', data.toString()));
ws.on('close', (code) => console.log('CLOSE', code));
"
```

Requires `ws` to be resolvable — run from inside the repo, or set
`NODE_PATH` to its `node_modules`.
