# brain-gpt4o

GPT-4o brain service for [veralux-voice-runtime](https://github.com/your-org/veralux-voice-runtime). The runtime POSTs transcript and history here; this service calls OpenAI and returns `{ text, transfer? }` in the format the runtime expects.

## Setup

1. **Install and build**

   ```bash
   cd brain-gpt4o
   npm install
   npm run build
   ```

2. **Configure**

   Set `OPENAI_API_KEY` in the **root** repo `.env` (same file as `BRAIN_URL`). The brain service loads it from there so you can manage all keys in one place.

3. **Run**

   ```bash
   npm run dev
   ```

   Server listens on port **3001** by default (`PORT` in `.env`).

## Wiring to the runtime

In the **voice runtime** `.env`, set the brain URL to this service:

```env
BRAIN_URL=http://localhost:3001
```

If you use streaming in the runtime:

```env
BRAIN_STREAMING_ENABLED=true
```

The runtime will then call:

- **POST** `http://localhost:3001/reply` (non-streaming)
- **POST** `http://localhost:3001/reply/stream` (streaming, when enabled)

## API

- **POST /reply** — Request body: `{ tenantId?, callControlId, transcript, history?, transferProfiles? }`. Response: `{ text: string, transfer?: { to, audioUrl?, timeoutSecs? } }`.
- **POST /reply/stream** — Same body; response is SSE: `event: token` with `data: { "t": "chunk" }`, then `event: done` with `data: { text, transfer? }`.
- **GET /health** — `{ ok: true, model: "gpt-4o" }`.

## Transfer and transfer profiles

When the runtime sends **transferProfiles** (departments/positions and their numbers), the model can choose to transfer the call. It uses a `transfer_call` tool with `to` (E.164 or SIP) and `message_to_caller`. The service returns `transfer: { to, audioUrl?, timeoutSecs? }` so the runtime can perform the transfer and optionally play a hold message.

## Model

Default model is **gpt-4o**. Override with:

```env
OPENAI_MODEL=gpt-4o-mini
```

(or any other chat model that supports tool/function calling).
