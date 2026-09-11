# Handover: Deepgram Flux AU custom STT

## Why this repo exists

Cognigy Voice Gateway (VG) does not currently support what we need for this
engagement:

- No on-prem / self-hosted Deepgram Flux capability.
- No AU region selector in the Deepgram STT vendor dropdown in the VG portal.

Because neither gap can be closed through VG's native Deepgram integration,
the only path available is a **custom speech vendor** integration — i.e.
standing up our own HTTP/WebSocket server that VG talks to via its custom
speech API, which in turn talks to Deepgram Flux (AU) on our behalf.

## What this repo is

This is a fork of [`Cognigy/custom-speech-example`](https://github.com/Cognigy/custom-speech-example),
which is Cognigy's own reference implementation for building custom
STT/TTS vendors behind VG. It exists purely to demonstrate the VG custom
speech contract, with one working example per vendor:

- **STT** (WebSocket, `/transcribe/<provider-name>`): google, gladia,
  assemblyAI, Vosk — see `lib/stt/`.
- **TTS** (HTTP POST, `/synthesize/<provider-name>`): google, elevenlabs,
  rime (non-streaming), deepgram (**streaming** reference — TTS only, no
  STT example for Deepgram in the template).

Repo remotes:
- `origin` → `ben-elliot-nice/custom-speech-deepgramflux-au-vg` (this fork, public)
- `upstream` → `Cognigy/custom-speech-example` (for pulling template updates)

## What's NOT done yet

No Deepgram Flux implementation exists in this repo yet. This is scaffolding
only — the fork + clone. The actual work is still ahead:

1. Add a new STT module, e.g. `lib/stt/deepgramFlux.js`, wired into
   `lib/stt/index.js` under a new provider path (e.g. `/transcribe/deepgramFlux`).
2. Implement against Deepgram Flux's real-time/streaming STT API, pointed at
   the **AU region** endpoint (Deepgram supports regional routing — confirm
   exact AU endpoint/hostname before starting).
3. Conform to VG's custom STT WebSocket contract — see `DEVELOPER_GUIDE.md`
   in this repo for the authoritative shape (message framing, `stop`
   semantics, turn detection, auth header handling). Read this before writing
   code; don't infer the contract from the other STT examples alone, since
   Deepgram Flux's turn-taking/endpointing model differs from the simpler
   STT vendors already in the repo (Flux has its own utterance/turn signals
   that need to be translated into whatever VG expects).
4. Add config: likely `DEEPGRAM_API_KEY` (may already be reused from the TTS
   example) plus something to pin the AU region — don't assume the existing
   `DEEPGRAM_API_KEY` env var covers both use cases without checking scoping/
   permissions on the Deepgram account.
5. Update `README.md` / `.env` instructions once the module exists.

## Key references

- `DEVELOPER_GUIDE.md` — the authoritative VG custom-speech contract
  (request/response shapes, auth, streaming vs non-streaming, STT stop
  semantics and turn detection).
- `lib/tts/deepgram.js` — existing Deepgram integration in this repo, but
  it's **TTS only** (streaming WAV synthesis via `/v1/speak`). Useful for
  seeing how Deepgram auth/requests are structured in this codebase, but it
  is not a starting point for the STT side — Flux's API and message model
  are unrelated to `/v1/speak`.
- `lib/stt/*.js` — existing STT vendor examples; useful for the VG-facing
  WebSocket handling pattern (message parsing, forwarding audio, sending
  transcripts back), but none of them use Deepgram.
