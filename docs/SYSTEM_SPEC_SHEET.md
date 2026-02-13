# VeraLux AI Receptionist — System Spec Sheet

**Generated:** February 12, 2026
**Deployment Mode:** On-Premise (Single Machine)
**Status:** Production Ready

---

## Host Machine

| Spec | Value |
|------|-------|
| **OS** | Ubuntu 24.04.2 LTS (Noble Numbat) |
| **Kernel** | Linux 6.14.0-37-generic |
| **CPU** | AMD Ryzen 9 7950X — 16 Cores / 32 Threads |
| **CPU Clock** | 425 MHz – 5,883 MHz (boost) |
| **RAM** | 94 GB DDR5 |
| **GPU** | NVIDIA GeForce RTX 4080 SUPER — 16 GB VRAM |
| **Storage** | 1.8 TB NVMe SSD (9% used / 1.6 TB free) |
| **Docker** | v29.2.1 |
| **Boot Mode** | Auto-start (Docker enabled via systemd) |

---

## System Resource Draw (Idle / Standby)

### Total Draw

| Resource | Usage | Available |
|----------|-------|-----------|
| **CPU** | ~1.5% | 98.5% free |
| **RAM** | ~3.2 GB (of services) | 84 GB available |
| **GPU VRAM** | ~5,050 MiB (31%) | 10,788 MiB free |
| **Disk (repo)** | 1.2 GB | — |
| **Disk (Docker images)** | 85.1 GB | — |
| **Disk (containers)** | 3.4 GB | — |

### Per-Service Resource Draw

| Service | CPU | RAM | RAM Limit | GPU VRAM | Image Size |
|---------|-----|-----|-----------|----------|------------|
| **Control Plane** | 0.02% | 35 MiB | 1 GiB | — | 337 MB |
| **Voice Runtime** | 0.16% | 43 MiB | 2 GiB | — | 3.4 GB |
| **Whisper STT** | 0.18% | 384 MiB | 6 GiB | ~796 MiB | 8.73 GB |
| **Kokoro TTS** | 0.18% | 1,001 MiB | 4 GiB | ~2,168 MiB | 7.37 GB |
| **XTTS TTS** (standby) | 0.20% | 1,664 MiB | 6 GiB | ~2,086 MiB | 14.4 GB |
| **Brain LLM** (proxy) | 0.00% | 27 MiB | 512 MiB | — | 223 MB |
| **PostgreSQL** | 0.00% | 33 MiB | 1 GiB | — | (base image) |
| **Redis** | 0.29% | 6 MiB | 512 MiB | — | (base image) |
| **Cloudflared** | 0.02% | 15 MiB | 256 MiB | — | (base image) |

> **Note:** XTTS is in standby (Kokoro is the active TTS engine). Both remain loaded in memory for instant failover. During active calls, CPU and GPU utilization spike proportionally to concurrent call volume.

---

## Response Times

### Health Endpoints

| Endpoint | Response Time | Status |
|----------|--------------|--------|
| Control Plane `/health` | **1.7 ms** | 200 OK |
| Voice Runtime `/health/live` | **1.2 ms** | 200 OK |
| Control Plane `/ready` (DB + Redis check) | **3.4 ms** | 200 OK |
| Whisper STT `/health` | **1.2 ms** | 200 OK |

### API Endpoints

| Endpoint | Response Time | Status |
|----------|--------------|--------|
| `GET /api/tts/config` | **3.3 ms** | 200 OK |
| `GET /api/admin/tenants` | **1.8 ms** | 200 OK |
| `GET /api/admin/workflows` | **2.2 ms** | 200 OK |

### Data Stores

| Service | Latency |
|---------|---------|
| **PostgreSQL** (query) | **0.16 ms** |
| **Redis** (ping) | **0.09 ms** avg (99th percentile: 1 ms) |

### Call Processing Pipeline (Estimated per Turn)

| Stage | Typical Latency | Description |
|-------|----------------|-------------|
| **Telnyx → Webhook** | 50–150 ms | Network hop from Telnyx to Cloudflare tunnel |
| **VAD (Silero)** | 5–15 ms | Voice activity detection on audio chunk |
| **STT (Whisper)** | 200–800 ms | Speech-to-text transcription (GPU-accelerated) |
| **LLM (Brain)** | 300–1,500 ms | AI response generation (GPT-4o via API) |
| **TTS (Kokoro)** | 100–400 ms | Text-to-speech synthesis (GPU-accelerated) |
| **Audio Delivery** | 20–50 ms | Stream synthesized audio back to caller |
| **Total Turn** | **~0.7 – 3.0 s** | End-to-end from user speech to AI response |

> **Note:** LLM latency depends on OpenAI API response time (external). All other stages are local GPU-accelerated processing.

---

## Network Architecture

| Port | Service | Exposure | Protocol |
|------|---------|----------|----------|
| 4000 | Control Plane | Host-mapped | HTTP/REST |
| 4001 | Voice Runtime | Host-mapped | HTTP/REST + WebSocket |
| 3001 | Brain LLM Proxy | Internal only | HTTP |
| 9000 | Whisper STT | Internal only | HTTP |
| 7001 | Kokoro TTS | Internal only | HTTP |
| 7002 | XTTS TTS | Internal only | HTTP |
| 5432 | PostgreSQL | Internal only | TCP |
| 6379 | Redis | Internal only | TCP |
| — | Cloudflared | Outbound tunnel | HTTPS (Cloudflare) |

> **Security:** Only ports 4000 and 4001 are exposed to the host. All AI/ML services (Brain, Whisper, Kokoro, XTTS) and data stores (Postgres, Redis) are on an isolated Docker network with no host access.

---

## Services Overview

### 1. Control Plane (`veralux-control`)
- **Role:** API server, tenant configuration, admin panel, owner panel, workflow engine
- **Tech:** Node.js / Express / TypeScript
- **Database:** PostgreSQL (tenant configs, workflows, leads, auth, usage)
- **Cache:** Redis (rate limiting, session data)

### 2. Voice Runtime (`veralux-runtime`)
- **Role:** Real-time call handling, Telnyx webhook processing, audio pipeline orchestration
- **Tech:** Node.js / TypeScript
- **Protocols:** HTTP REST, WebSocket (media streams)
- **Integrations:** Telnyx (calls), Whisper (STT), Kokoro/XTTS (TTS), Brain (LLM)

### 3. Brain LLM Proxy (`veralux-brain`)
- **Role:** Routes LLM requests to OpenAI GPT-4o
- **Tech:** Node.js proxy
- **External Dependency:** OpenAI API (requires internet)

### 4. Whisper STT (`veralux-whisper`)
- **Role:** Speech-to-text transcription
- **Tech:** OpenAI Whisper (large-v3) running on local GPU
- **Model Size:** ~1.5 GB (weights in VRAM)
- **Processing:** Fully local, no external API calls

### 5. Kokoro TTS (`veralux-kokoro`) — Active
- **Role:** Text-to-speech synthesis
- **Tech:** Kokoro TTS running on local GPU
- **Model Size:** ~2.2 GB VRAM
- **Processing:** Fully local, no external API calls

### 6. XTTS TTS (`veralux-xtts`) — Standby
- **Role:** Alternate text-to-speech engine (voice cloning capable)
- **Tech:** Coqui XTTS v2 running on local GPU
- **Model Size:** ~2.1 GB VRAM
- **Processing:** Fully local, no external API calls

### 7. PostgreSQL (`veralux-postgres`)
- **Role:** Primary data store
- **Data:** Tenant configs, user accounts, workflows, leads, call logs, usage metering, auth tokens
- **Backup:** Automated daily (cron)

### 8. Redis (`veralux-redis`)
- **Role:** Caching, rate limiting, session data
- **Persistence:** AOF + periodic snapshots
- **Backup:** Automated daily (cron)

### 9. Cloudflared (`veralux-cloudflared`)
- **Role:** Secure tunnel exposing the system to the internet without port forwarding
- **Tech:** Cloudflare Tunnel (Argo)
- **Dependency:** Requires internet connectivity

---

## External Dependencies

| Service | Purpose | Required |
|---------|---------|----------|
| **OpenAI API** | GPT-4o for conversational AI | Yes (for LLM responses) |
| **Telnyx** | Phone calls, SIP, DID numbers | Yes (for telephony) |
| **Cloudflare Tunnel** | Public webhook ingress | Yes (for receiving calls) |
| **Internet** | API access + tunnel | Yes |

---

## Fault Tolerance

| Scenario | Behavior |
|----------|----------|
| **Service crash** | Docker auto-restarts (`restart: unless-stopped`) |
| **Port conflict** | Recovery Mode in Electron app clears ports and restarts |
| **Power outage + restore** | Docker starts on boot → all services auto-restart (no login needed) |
| **Internet outage** | Calls cannot be received (Telnyx cannot reach webhook) |
| **Machine stays down** | System offline — configure Telnyx failover number as safety net |
| **GPU driver crash** | STT/TTS containers restart; may need manual `nvidia-smi` reset |

---

## Capacity (Single Machine)

| Metric | Estimate |
|--------|----------|
| **Concurrent calls** | 5–10 (configurable, GPU-bound) |
| **Calls per minute** | ~30 (rate limited) |
| **STT throughput** | ~10x real-time (Whisper large-v3 on RTX 4080 Super) |
| **TTS throughput** | ~15x real-time (Kokoro on RTX 4080 Super) |
| **Database connections** | 200 max (PostgreSQL) |
| **Storage runway** | ~1.6 TB free at 9% usage |
