# XTTS v2 Tuning Guide

When using Coqui XTTS for TTS (`TTS_MODE=coqui_xtts`), the runtime can send optional tuning parameters to your XTTS server. This document explains what each knob does and how to set them.

## How to set tuning

- **Global (all tenants):** Add the variables to `.env`. If you use tenant config in Redis, re-run `npx tsx scripts/register-tenant.ts` so the tenant gets the updated values from env.
- **Per tenant:** Edit the tenant config in Redis: under the `tts` object (with `mode: "coqui_xtts"`), add any of the `coqui*` fields. Tenant config overrides env.

See [configuration.md](configuration.md) for Redis/tenant details.

---

## Tuning parameters

### COQUI_TEMPERATURE (default 0.65)

- **What it is:** Softmax temperature for the autoregressive (GPT) part of XTTS.
- **Effect:**
  - **Higher** (e.g. 0.8–0.9) → more varied, less predictable phrasing and prosody; can sound more “creative” or slightly less stable.
  - **Lower** (e.g. 0.5–0.6) → more deterministic, stable, sometimes flatter.
- **Typical use:** Slight tweaks (0.6–0.75) to balance natural variation vs consistency.

---

### COQUI_LENGTH_PENALTY (default 1.0)

- **What it is:** Length penalty used in beam-style decoding.
- **Effect:**
  - **> 1.0** → tends to favor **shorter** outputs (tighter, less drawn-out).
  - **< 1.0** → tends to favor **longer** outputs.
- **Typical use:** Nudge up (e.g. 1.1–1.2) if the model is too wordy or stretches pauses.

---

### COQUI_REPETITION_PENALTY (default 2.0)

- **What it is:** Penalty that discourages the model from repeating the same tokens.
- **Effect:**
  - **Higher** → fewer repeated sounds/words (e.g. “uhhhhh”, stutters, repeated syllables).
  - **Lower** → more repetition, sometimes more “uh”s or stuck loops.
- **Typical use:** Increase (e.g. 2.5–3.0) if you hear obvious repeats or filler; don’t push too high or speech can get odd.

---

### COQUI_TOP_K (default 50)

- **What it is:** Top-k sampling: at each step the model only considers the top *k* most likely next tokens.
- **Effect:**
  - **Lower** (e.g. 20–30) → more conservative, “safe” output; can sound a bit bland.
  - **Higher** (e.g. 80–100) → more diversity; can occasionally sound weirder.
- **Typical use:** Small adjustments; 40–60 is a common range.

---

### COQUI_TOP_P (default 0.8)

- **What it is:** Nucleus (top-p) sampling: at each step the model samples from the smallest set of tokens whose cumulative probability reaches *p*.
- **Effect:**
  - **Lower** (e.g. 0.6–0.7) → more focused, predictable.
  - **Higher** (e.g. 0.9) → more variety.
- **Typical use:** Often tuned together with `COQUI_TOP_K`; both control “creativity” vs “safety”.

---

### COQUI_SPEED (default 1.0)

- **What it is:** Playback speed multiplier for the generated audio.
- **Effect:**
  - **1.0** = normal.
  - **> 1.0** (e.g. 1.1–1.2) = faster.
  - **< 1.0** (e.g. 0.9) = slower.
- **Typical use:** Small changes (0.9–1.15); large values can introduce artifacts.

---

### COQUI_SPLIT_SENTENCES (default true in .env)

- **What it is:** Whether to split the input text into sentences and synthesize each sentence separately, then concatenate.
- **Effect:**
  - **true** → longer texts are handled in chunks; lower VRAM and avoids hitting max length; can lose a bit of flow between sentences.
  - **false** → whole text in one go; better cross-sentence flow but higher VRAM and risk of hitting context limits.
- **Typical use:** Keep `true` for long or multi-sentence replies; set `false` only if you need maximum continuity and your server can handle it.

---

## Quick reference

| Knob | Raise it when… | Lower it when… |
|------|----------------|----------------|
| **temperature** | You want more variation/expressiveness | Speech is too unstable or odd |
| **length_penalty** | Output is too long or drawn-out | Output feels too clipped |
| **repetition_penalty** | You hear “uh”s, stutters, or repeats | Speech sounds over-penalized or unnatural |
| **top_k / top_p** | You want more variety | You want more consistent, conservative speech |
| **speed** | You want faster delivery | You want slower, clearer delivery |
| **split_sentences** | You have long texts and want stability | You care most about flow across sentences |

---

## Env variable names

In `.env` or tenant config (camelCase in Redis), use:

| Env (.env) | Tenant config (Redis) |
|------------|------------------------|
| `COQUI_TEMPERATURE` | `coquiTemperature` |
| `COQUI_LENGTH_PENALTY` | `coquiLengthPenalty` |
| `COQUI_REPETITION_PENALTY` | `coquiRepetitionPenalty` |
| `COQUI_TOP_K` | `coquiTopK` |
| `COQUI_TOP_P` | `coquiTopP` |
| `COQUI_SPEED` | `coquiSpeed` |
| `COQUI_SPLIT_SENTENCES` | `coquiSplitSentences` |

Your XTTS server must accept these in the request body (snake_case: `temperature`, `length_penalty`, etc.) for tuning to take effect.
