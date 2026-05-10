# Voice pipeline — current state and revert path

## Active pipeline (default)

**`v2` — engaged thinking partner powered by `gpt-realtime-2`.**

The model is a brief, sharp conversational partner: it captures the user's
ideas as a graph via tool calls AND engages — asking clarifying questions,
probing for depth, surfacing synthesis when patterns emerge. The user is
doing the thinking; the model is a focused prompt.

Three modes, all driven by what the user says:

- **Default (engaged)** — every user turn produces tool calls + an optional
  brief spoken response (one short clarifier, probe, or synthesis). The model
  stays quiet on incremental turns.
- **Silent capture** — triggered by phrases like "just listen", "let me think",
  "no questions", "let me cook". The model emits tool calls only, no audio.
  Stays silent until the user resumes ("ask me", "what do you think") or
  hits a termination phrase.
- **Termination** — phrases like "done", "finished", "ok process", "wrap it
  up" make the model call `finalize_session` and speak a structured closing
  summary, then disconnect.

| Concern | Location |
|---|---|
| Client | `public/js/realtime.v2.js` |
| Server endpoints | `server.js` — `/voice/concept`, `/voice/claim`, `/voice/move`, `/voice/remove`, `/voice/merge`, `/voice/insight`, `/voice/snapshot`, `/voice/focus` |
| OpenAI model | `gpt-realtime-2` |
| Pipeline switch | `public/js/main.js` line ~10 — reads `localStorage['pharos-voice-pipeline']`, defaults to `'v2'` |
| Server model env | `REALTIME_MODEL` (defaults to `gpt-realtime-2`) |
| Reasoning effort | Driven by the system-prompt directive ("Use medium reasoning effort"); the realtime API does not expose `reasoning_effort` at the `session` level |

## Legacy pipeline (preserved, not active)

**`legacy` — chained pipeline using `gpt-realtime-mini` for transcription only,
then Claude (Anthropic / OpenRouter) for graph resolution.**

| Concern | Location |
|---|---|
| Client | `public/js/realtime.legacy.js` (verbatim copy of the original `realtime.js`) |
| Server endpoint | `/ingest` → `pharos-resolver.js` → Anthropic / OpenRouter |
| OpenAI model | `gpt-realtime-mini` |
| Untouched files | `pharos-resolver.js`, `pharos-prompt.js`, `pharos-store.js`, `/ingest` route |

The legacy file is hardcoded to `gpt-realtime-mini` in two places: the `MODEL`
constant at the top of `realtime.legacy.js` and the SDP URL further down. The server
must also request that model in `/session`, so reverting requires both flags below.

## To switch pipelines

**In-app (recommended for testing):** two pill-shaped buttons sit to the right of
the record button — *Pharos pipeline* (legacy chained) and *NEW Realtime-2 model*
(silent listener). Clicking a pill swaps the active pipeline immediately, stops
any live session, and persists the choice to `localStorage` under
`pharos-voice-pipeline`. Both modules are preloaded so the switch is instant.

**Programmatic:**
```js
localStorage.setItem('pharos-voice-pipeline', 'legacy'); // or 'v2'
location.reload();
```

**Server-side model** — must agree with the active client pipeline:
- For `v2`: `REALTIME_MODEL=gpt-realtime-2` (or unset; default is `v2`).
- For `legacy`: `REALTIME_MODEL=gpt-realtime-mini`.

Set via `.env` or inline (`REALTIME_MODEL=gpt-realtime-mini npm start`) and
restart the server. The `/voice/*` endpoints stay live but inert when the
legacy client is active.

## Toggle quick-reference

| Goal                              | `pharos-voice-pipeline` (localStorage) | `REALTIME_MODEL` env |
|-----------------------------------|----------------------------------------|----------------------|
| Silent listener (default)         | `v2` *or* unset                        | `gpt-realtime-2`     |
| Original chatty pipeline          | `legacy`                               | `gpt-realtime-mini`  |
| Silent listener on cheaper model  | `v2`                                   | `gpt-realtime-mini`  |
| Legacy chat on new model          | `legacy`                               | `gpt-realtime-2`     |

## What `v2` actually does

1. **Mic on** — `POST /session` mints an OpenAI ephemeral key and reports the model.
2. **Snapshot** — `POST /voice/snapshot` returns the current graph (codes + labels +
   parent codes) plus the current focus node. This is embedded into the system prompt
   so the model knows where it is at session start.
3. **Greeting** — client sends a one-shot `response.create` with
   `output_modalities: ['audio']` and instructions to say a short warm opener.
4. **Engaged capture loop** — server VAD detects end-of-turn, the model emits
   tool calls (possibly with brief audio commentary or a follow-up question).
   The client executes each call against `/voice/*`, posts `function_call_output`,
   and sends a continuation `response.create` (no modality override — the
   session default `['audio']` rules, but the model decides whether to actually
   speak based on its instructions). Silent mode is enforced by the prompt
   when the user has triggered it.
5. **Focus tracking** — when the user clicks a different node mid-recording,
   `main.js` calls `realtime.pushFocusChange()` which (a) `POST /voice/focus`
   updates the server-side per-session focus, and (b) injects a system message
   into the conversation so the model knows.
6. **Termination** — when the user says a trigger phrase the model calls
   `finalize_session`, which builds a summary payload from the client-side
   session log (concepts created, branches opened, insights, claims). The client
   then sends a `response.create` with `output_modalities: ['audio']` and
   the summary data — the model speaks the closing summary.
7. **Disconnect** — three seconds after the summary turn ends, the client tears
   down the WebRTC connection and returns the UI to ready.

## Why we kept the legacy pipeline

Voice-mode ingestion via Claude is battle-tested and behaves predictably. If
`gpt-realtime-2` hallucinates structure, mishandles silence, or the OpenAI
realtime API has an outage, flipping the localStorage flag and the env var
restores prior behaviour with zero code changes.

The Claude resolver also still backs the **text input**, **GitHub repo ingest**,
and **markdown drop** modes via `/ingest` — those are unaffected by the voice
pipeline switch.

## Hard delete (not recommended yet)

If you ever want to remove the legacy pipeline entirely:

- Delete `public/js/realtime.legacy.js`.
- Remove the dynamic-import branch in `public/js/main.js` and import
  `./realtime.v2.js` directly.
- **Do NOT delete** `pharos-resolver.js`, `pharos-prompt.js`, or the `/ingest`
  endpoint — they still serve text, GitHub, and markdown ingestion modes.

## Tuning knobs

- `REALTIME_MODEL` (env) — model used by the server for `/session`.
- Reasoning effort — currently steered via the system-prompt line "Use medium
  reasoning effort" in `realtime.v2.js → buildSystemPrompt`. If/when OpenAI
  surfaces an explicit knob in the realtime API, wire it there.
- `silence_duration_ms` in `sendSessionUpdate` — VAD breathing room between
  utterances; raise if the model fires on the user's mid-sentence pauses.
- The system prompt itself is in `realtime.v2.js → buildSystemPrompt`. The
  trigger phrases for ending a session live in the **Termination Triggers**
  section there.
