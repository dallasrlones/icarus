# Voice APIs

icarus speaks to two upstream services for voice:

- **STT** — speech-to-text (audio in, transcript out)
- **TTS** — text-to-speech (text in, audio out)

Both are configurable, and **either can be swapped at runtime** for any
service that speaks the icarus voice contract documented below. The
default reference implementation runs on a Jetson Orin (faster-whisper +
XTTS-v2), but nothing about icarus assumes that — point the URLs at any
host that implements the three endpoints below and it will Just Work.

This document is meant to be read by **two audiences**:

1. **Humans** wiring up a self-hosted voice stack or a third-party proxy.
2. **Coding agents** (Cursor, Claude, etc.) being asked to plug a new
   voice provider into their user's icarus install. If you are an agent
   reading this: the contract is small (3 endpoints), the configuration
   surface is small (Settings tab → Voice APIs OR `PATCH /v1/settings/voice`),
   and you can verify your work by checking `GET /v1/voice/health` after
   reconfiguring.

---

## Quick reference

| Concept           | Where it lives                                                                |
|-------------------|-------------------------------------------------------------------------------|
| Default URLs      | `.env` (`VOICE_STT_URL`, `VOICE_TTS_URL`)                                     |
| Runtime overrides | `store/settings.json` → `voice.stt` / `voice.tts`                             |
| UI form           | Global cockpit → **Settings** tab → "Voice APIs" section                       |
| Read API          | `GET /v1/settings/voice`                                                       |
| Write API         | `PATCH /v1/settings/voice` (humans · includes auth tokens)                     |
| Agent-facing API  | `set_voice_endpoints` mutation envelope (no auth — UI-only)                    |
| Health probe      | `GET /v1/voice/health`                                                         |
| Reference impl    | `~/work/tools/stt-service` (faster-whisper) and `tts-service` (XTTS-v2) on a Jetson Orin |

Resolution order for each field: **settings.json override → env var → built-in default**.
Both URLs unset ⇒ voice is feature-flagged off; the mic button never renders and
voice POST endpoints fast-fail with HTTP 503.

---

## The icarus voice contract

A "voice provider" is any HTTP service that exposes these three
endpoints. The icarus server proxies between the client and the
provider — clients never call the provider directly.

### `GET /health`

Cheap liveness probe. Called once on icarus boot and on every
`voice_settings_changed` broadcast. Must return inside 4 seconds or
icarus marks the upstream unhealthy.

**Response (STT)**

```json
{ "model": "large-v3-turbo", "device": "cuda" }
```

**Response (TTS)**

```json
{
  "default_voice": "jarvis",
  "sample_rate": 24000,
  "voices": ["default", "jarvis", "fred", "alice"]
}
```

Required fields: any 200 OK with valid JSON is healthy. The shown fields
are surfaced in the Settings UI / sidebar pill but none are strictly
required — the icarus server reads them defensively. The `voices` list
is the one exception: when present, icarus uses it to validate that the
configured voice name exists, and surfaces a clear error if not.

### `POST /transcribe` (STT only)

Multipart form upload of one audio clip. Server returns the transcript.

**Request**

- `Content-Type: multipart/form-data`
- Fields:
  - `file` — the audio bytes (`webm`, `m4a`, `mp3`, `ogg`, `wav`, `flac`)
  - `language` — optional ISO short code (`en`, `es`, …); omit for auto-detect
  - `task` — optional, one of `"transcribe"` (same language) or `"translate"` (to English)

**Response**

```json
{
  "text": "open the tasks tab",
  "language": "en",
  "language_probability": 0.99,
  "duration": 1.23,
  "segments": []
}
```

The only required field icarus reads is `text`. The rest are surfaced
to the activity log for debugging but otherwise ignored.

### `POST /synthesize` (TTS only)

JSON request, audio response. icarus splits long replies into ≤240-char
sentence chunks before calling — providers don't need to handle
megabyte-scale text in one shot.

**Request**

```json
{
  "text": "Hello, world.",
  "voice": "jarvis",
  "language": "en",
  "speed": 1.0
}
```

- `text` — required, ≤4900 chars (icarus clamps before forwarding)
- `voice` — optional, falls back to provider's default
- `language` — optional ISO short code, falls back to `en`
- `speed` — optional, `0.5..2.0`, falls back to `1.0`

**Response**

- `Content-Type: audio/wav` (or any audio MIME type the browser can play)
- Body: raw audio bytes, fully buffered (no streaming)
- Optional headers (passed through to the client):
  - `X-Voice` — actual voice used
  - `X-Language` — actual language used

### Authentication (optional)

If a `Bearer` token is configured for the upstream (Settings tab →
Voice APIs → STT/TTS Auth), icarus sends it as

```
Authorization: Bearer <token>
```

on every call (health probe, transcribe, synthesize). Providers that
need a different scheme (e.g. ElevenLabs' `xi-api-key` header) require
a wrapping proxy — see "Wrapping a third-party provider" below.

---

## Configuring icarus

### From the UI

Open the global cockpit → **Settings** tab → "Voice APIs" section.
Each field is independent:

| Field         | Effect                                                                  |
|---------------|-------------------------------------------------------------------------|
| STT URL       | Override `VOICE_STT_URL`. Blank = use env. Any URL the contract speaks. |
| STT Auth      | Bearer token for STT (sent if non-empty).                               |
| TTS URL       | Override `VOICE_TTS_URL`.                                               |
| TTS Auth      | Bearer token for TTS.                                                   |
| Voice         | Voice catalog name (e.g. `jarvis`). Blank = use provider default.       |
| Language      | ISO short code (e.g. `en`).                                             |

Click **SAVE** to persist; the sidebar voice pill re-probes health on
the new endpoint within ~1s. **CLEAR ALL** drops every override back to
env / built-in.

The form shows an "env" / "custom" / "unset" badge next to each URL so
you can tell at a glance whether you're running on `.env` defaults or
your own override.

### From `.env`

Edit `.env` (copied from `.env.example`):

```bash
VOICE_STT_URL=http://your-jetson.lan:8001
VOICE_TTS_URL=http://your-jetson.lan:8002
VOICE_TTS_VOICE=default
VOICE_TTS_LANGUAGE=en
```

Restart the server. Env vars are the bottom of the resolution stack:
they only apply if no settings override is present.

### From the API (humans)

```bash
# inspect current resolved config
curl http://localhost:4000/v1/settings/voice

# point at a different STT, leave TTS alone
curl -X PATCH http://localhost:4000/v1/settings/voice \
  -H 'Content-Type: application/json' \
  -d '{ "stt_url": "http://my-host:9000" }'

# clear all overrides — env wins again
curl -X PATCH http://localhost:4000/v1/settings/voice \
  -H 'Content-Type: application/json' \
  -d '{ "stt_url": "", "tts_url": "", "stt_auth": "", "tts_auth": "", "voice": "", "language": "" }'
```

`PATCH` semantics:

- field **omitted** → leave current value untouched
- field **`""`** (empty string) → clear (env-var fallback wins)
- field **`"***"`** → leave existing auth token untouched (so the form
  can be resubmitted without re-pasting secrets)

### From chat (agents)

The `set_voice_endpoints` mutation is wired into the agent's command
vocabulary. **Auth tokens are deliberately excluded** from this
verb — the mutation envelope rides chat history and the activity log,
and surfacing Bearer tokens through it would be a leak risk.

```icarus
{
  "kind": "set_voice_endpoints",
  "payload": {
    "stt_url": "http://my-host:9000",
    "voice": "fred",
    "language": "en"
  }
}
```

If the user asks an agent to plug in a provider that needs an API key
(OpenAI, ElevenLabs, …), the agent should configure URLs via this
mutation and then point the user at the Settings tab → Voice APIs form
to paste the token.

---

## Wrapping a third-party provider

The icarus contract doesn't match any single commercial API exactly,
but you can adapt anything in ~50 lines of Python or Node. The
recipe:

1. Stand up a small HTTP service on `localhost:9000` (or wherever).
2. Implement the three endpoints described above. Map their fields to
   the upstream provider's request/response shape.
3. Point icarus at your wrapper with `PATCH /v1/settings/voice`.

### Worked example — OpenAI Whisper API as STT

```python
# stt-openai-wrapper.py
from fastapi import FastAPI, UploadFile, Form
import httpx, os

app = FastAPI()
OPENAI_KEY = os.environ["OPENAI_API_KEY"]

@app.get("/health")
def health():
    return {"model": "openai-whisper-1", "device": "remote"}

@app.post("/transcribe")
async def transcribe(file: UploadFile, language: str | None = Form(None)):
    files = {"file": (file.filename, await file.read(), file.content_type)}
    data = {"model": "whisper-1"}
    if language:
        data["language"] = language
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            files=files,
            data=data,
        )
        r.raise_for_status()
        body = r.json()
    return {
        "text": body["text"],
        "language": language or "en",
        "language_probability": 1.0,
        "duration": 0.0,
        "segments": [],
    }
```

Run `uvicorn stt-openai-wrapper:app --port 9000`, then in icarus:

```bash
curl -X PATCH http://localhost:4000/v1/settings/voice \
  -H 'Content-Type: application/json' \
  -d '{ "stt_url": "http://localhost:9000" }'
```

### Worked example — ElevenLabs as TTS

```python
# tts-elevenlabs-wrapper.py
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
import httpx, os

app = FastAPI()
EL_KEY = os.environ["ELEVENLABS_API_KEY"]
DEFAULT_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")

class SynthReq(BaseModel):
    text: str
    voice: str | None = None
    language: str | None = None
    speed: float = 1.0

@app.get("/health")
def health():
    return {"default_voice": "rachel", "sample_rate": 44100, "voices": ["rachel", "antoni"]}

@app.post("/synthesize")
async def synth(req: SynthReq):
    voice_id = req.voice or DEFAULT_VOICE_ID
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={"xi-api-key": EL_KEY, "Accept": "audio/mpeg"},
            json={"text": req.text, "model_id": "eleven_multilingual_v2"},
        )
        r.raise_for_status()
    return Response(
        content=r.content,
        media_type="audio/mpeg",
        headers={"X-Voice": voice_id, "X-Language": req.language or "en"},
    )
```

---

## Disabling voice

Two off switches:

1. **User toggle** — Settings → "Voice APIs" or sidebar pill (or chat
   "turn off voice"). Hard-disables the feature globally:
   - Health probe short-circuits (no 4s LAN timeout when off-LAN)
   - All voice POST endpoints return HTTP 503
   - Mic button hides

2. **Endpoint unset** — clear both URLs and unset both env vars. Voice
   is feature-flagged off, the mic button never renders.

Either way, no audio leaves the device unless both ends are configured
*and* the user has voice enabled.

---

## Troubleshooting

| Symptom                                    | Likely cause                                    | Fix                                                                         |
|--------------------------------------------|-------------------------------------------------|-----------------------------------------------------------------------------|
| Mic button never renders                    | Both URLs unset, or `voice.disabled = true`     | Settings → Voice APIs OR `PATCH /v1/settings/voice`                          |
| "VOICE OFF" pill (amber)                    | Health probe failing                            | Read `GET /v1/voice/health` for the upstream's reason                        |
| "transcribing takes years"                  | STT running on CPU                              | Check `device` in `/health`; should be `cuda` on a GPU box                   |
| `voice "X" missing from upstream catalog`   | Configured `voice` not in TTS provider's `/health.voices` list | Update Voice field, or remove it to use the provider default                 |
| Auth token works in `curl` but not icarus  | Provider needs a non-Bearer scheme              | Wrap in a thin proxy that translates `Authorization: Bearer X` to your scheme |
| Container can't reach LAN voice host (macOS) | Docker networking limitation                    | Run icarus-server natively (`server/scripts/dev-native.sh`)                  |
