# Veralux Receptionist - Deployment Bundle

This package contains everything needed to deploy Veralux Receptionist using Docker — an AI-powered phone receptionist with voice cloning, real-time voice tuning, and a full business owner dashboard.

## Features

- **AI Receptionist** — Answers calls, takes messages, transfers calls, and quotes pricing
- **Voice Cloning** — Clone your own voice from a microphone recording or audio file upload
- **XTTS Voice Tuning** — Fine-tune speed, temperature, top-p, top-k, repetition penalty, and length penalty
- **Owner Portal** — Business owners can customize greetings, instructions, voice settings, pricing, call forwarding, and view analytics
- **Admin Panel** — System-level configuration and tenant management
- **Desktop App** — Electron-based desktop application with VeraLux branding (Linux)
- **Custom Greetings** — Greeting text set in the owner panel is automatically synced to the runtime and regenerated as audio
- **WebRTC HD Calls** — Browser-based high-definition calling alongside traditional PSTN

## Requirements

- **Docker Engine** 20.10+ with Docker Compose V2
- **Operating System**: Linux (Ubuntu 20.04+) or macOS
- **Ports**: 4000, 4001 (configurable)
- **Disk Space**:
  - Online install: ~2 GB (images pulled from registry)
  - Offline install: ~5 GB+ (includes pre-packaged images)

### Before You Start

Have these ready:
- **Telnyx API Key** and **Public Key** (from portal.telnyx.com)
- **Your domain name** (e.g., receptionist.yourcompany.com)

### GPU Services (Optional)

For GPU-accelerated services (Whisper, Kokoro, XTTS):
- NVIDIA GPU with CUDA support
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

---

## Quick Start (Easy - Recommended)

Works for both online and offline bundles:

```bash
# 1. Unzip the bundle
unzip veralux-receptionist-*.zip
cd veralux-receptionist-*/

# 2. Run the installer (walks you through everything)
./install.sh
```

That's it! The installer will:
- Check Docker is running
- Load images (if offline bundle)
- Ask for your Telnyx keys and domain
- Generate secure passwords automatically
- Start everything

---

## Quick Start (Manual)

If you prefer to configure manually:

```bash
# 1. Unzip the bundle
unzip veralux-receptionist-*.zip
cd veralux-receptionist-*/

# 2. For offline bundles only - load images first
./load-images.sh

# 3. Create and configure environment
cp .env.example .env
nano .env  # Edit with your settings

# 4. Start the application
./deploy.sh up

# 5. Verify it's running
./deploy.sh status
```

> **Note**: The offline bundle includes `images.tar.zst` which requires `zstd` to decompress.
> Install with: `sudo apt install zstd` (Ubuntu) or `brew install zstd` (macOS)

---

## Configuration

### Environment Variables

All configuration is done through the `.env` file. Key settings:

| Variable | Description | Required |
|----------|-------------|----------|
| `VERSION` | Application version | Yes |
| `REGISTRY` | Container registry URL | Yes |
| `POSTGRES_PASSWORD` | Database password | Yes |
| `JWT_SECRET` | Secret for JWT tokens | Yes |
| `BASE_URL` | Public URL of the application | Yes |

See `.env.example` for all available options with descriptions.

### Port Configuration

Default ports (change in `.env` if needed):

| Service | Port | Variable |
|---------|------|----------|
| Control Plane (API + UI) | 4000 | `CONTROL_PORT` |
| Runtime | 4001 | `RUNTIME_PORT` |
| PostgreSQL | 5432 | `POSTGRES_PORT` |

---

## Usage

### Deploy Script Commands

```bash
# Start all services
./deploy.sh up

# Start with GPU services enabled
./deploy.sh up --profile gpu

# Stop all services
./deploy.sh down

# Restart services
./deploy.sh restart

# Restart specific service
./deploy.sh restart control

# View service status
./deploy.sh status

# Follow all logs
./deploy.sh logs

# Follow specific service logs
./deploy.sh logs control

# Update to latest images (online only)
./deploy.sh update
```

---

## Troubleshooting

### Check Service Status

```bash
# Using deploy script
./deploy.sh status

# Direct Docker commands
docker ps
docker compose ps
```

### View Logs

```bash
# All services
./deploy.sh logs

# Specific service
./deploy.sh logs control

# Last 100 lines
docker compose logs --tail=100 control
```

### Common Issues

#### Services won't start

1. Check Docker is running:
   ```bash
   docker info
   ```

2. Check for port conflicts:
   ```bash
   # Linux
   sudo netstat -tlnp | grep -E '3000|5432|8081'
   
   # macOS
   lsof -i :3000 -i :5432 -i :8081
   ```

3. Check logs for errors:
   ```bash
   ./deploy.sh logs
   ```

#### Database connection errors

1. Verify PostgreSQL is running:
   ```bash
   docker compose ps postgres
   ```

2. Check PostgreSQL logs:
   ```bash
   ./deploy.sh logs postgres
   ```

3. Verify `.env` credentials match what PostgreSQL was initialized with

#### Images not found (online install)

1. Verify registry access:
   ```bash
   docker pull ${REGISTRY}/veralux-control:${VERSION}
   ```

2. Check if you need to authenticate:
   ```bash
   docker login ghcr.io
   ```

#### Offline install: zstd not found

Install zstd:
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y zstd

# macOS
brew install zstd
```

### Reset Everything

To completely reset and start fresh:

```bash
# Stop and remove containers, networks, volumes
docker compose down -v

# Remove local data
docker volume rm veralux-postgres-data veralux-redis-data

# Start fresh
./deploy.sh up
```

> **Warning**: This will delete all data including the database!

---

## Architecture

```
┌───────────────────┐     ┌─────────────┐
│   Control Plane   │────▶│   Runtime   │
│  (API + UI) :4000 │     │    :4001    │
└───────────────────┘     └─────────────┘
         │                       │
         ▼                       ▼
  ┌─────────────┐         ┌─────────────┐
  │  PostgreSQL │         │    Redis    │
  │    :5432    │         │    :6379    │
  └─────────────┘         └─────────────┘

Optional GPU Services (--profile gpu):
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Whisper   │  │   Kokoro    │  │    XTTS     │
│    :9000    │  │    :7001    │  │    :7002    │
└─────────────┘  └─────────────┘  └─────────────┘
```

### Data Flow

1. **Configuration** — Business owners configure greetings, prompts, voice settings, and pricing through the Owner Portal or Portal UI (served by the Control Plane on `:4000`).
2. **Sync** — The Control Plane persists configuration to PostgreSQL and publishes it to Redis. When prompts (including greeting text) are saved, it also triggers greeting audio regeneration on the Runtime.
3. **Calls** — Incoming calls hit the Runtime via Telnyx webhooks. The Runtime reads tenant configuration from Redis, synthesizes speech via XTTS or Kokoro, and uses Whisper for speech-to-text.
4. **Voice Cloning** — Audio samples uploaded through the portal are stored and referenced as `speakerWavUrl` in the TTS configuration, allowing XTTS to clone the uploaded voice.

---

## Owner Portal & Admin Panel

### Owner Portal (`/portal.html`)

The owner portal is the primary interface for business owners. Access it at `http://<your-domain>:4000/portal.html`.

**Features:**
- **Greeting & Prompts** — Customize the greeting message, business description, tone of voice, and policy rules
- **Voice Tuning** — Six sliders to fine-tune XTTS voice output:
  - Speed (0.5–2.0)
  - Temperature (0.01–1.50)
  - Top P (0.10–1.00)
  - Top K (1–200)
  - Repetition Penalty (1.0–5.0)
  - Length Penalty (0.5–2.0)
- **Voice Cloning** — Record from microphone or upload a `.wav`/`.mp3` file, preview, label, and save as a custom voice
- **Voice Selection** — Switch between preset and cloned voices
- **Call Forwarding** — Configure numbers and roles for call transfers
- **Pricing** — Set up service/product pricing the receptionist can quote
- **Analytics** — View call activity and lead capture
- **Billing** — Manage subscription (if Stripe is configured)

### Owner Panel (`/owner.html`)

A simpler owner interface with the same voice tuning and cloning capabilities. Access at `http://<your-domain>:4000/owner.html`.

### Admin Panel (`/admin.html`)

System administration interface for managing tenants, API keys, and system-level configuration. Access at `http://<your-domain>:4000/admin.html`.

---

## Desktop Application

An Electron-based desktop app is included in the `desktop/` directory for Linux systems.

### Running the Desktop App

```bash
cd desktop
npm install
npx electron --no-sandbox .
```

Or use the launcher script:

```bash
./desktop/start.sh
```

A `.desktop` file can be created to add a launcher to your Linux desktop. The app uses the VeraLux logo (`desktop/assets/icon.png`) for branding.

---

## Voice Configuration API

The Control Plane exposes a TTS configuration API at `/api/tts/config` (requires `X-Admin-Key` header).

### GET `/api/tts/config`

Returns the current voice configuration including mode, voice ID, cloned voice settings, and XTTS tuning parameters.

### POST `/api/tts/config`

Accepts JSON body with any of the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `ttsMode` | string | `coqui_xtts` or `kokoro_http` |
| `voiceId` | string | Voice identifier |
| `defaultVoiceMode` | string | `preset` or `cloned` |
| `clonedVoice` | object | `{ speakerWavUrl, label }` |
| `coquiSpeed` | number | Speed (0.5–2.0, default 1.18) |
| `coquiTemperature` | number | Temperature (0.01–1.50, default 0.80) |
| `coquiTopP` | number | Top P (0.10–1.00, default 0.92) |
| `coquiTopK` | number | Top K (1–200, default 50) |
| `coquiRepetitionPenalty` | number | Repetition penalty (1.0–5.0, default 2.0) |
| `coquiLengthPenalty` | number | Length penalty (0.5–2.0, default 1.0) |

### POST `/api/admin/voice-recordings`

Upload a voice sample for cloning. Send as `multipart/form-data` with an `audio` field containing a `.wav`, `.mp3`, `.ogg`, or `.webm` file (max 10 MB). Returns `{ url }` pointing to the stored file.

---

## Project Structure

```
veralux-receptionist-deploy/
├── control-plane/          # Control Plane service
│   ├── src/                # TypeScript source
│   ├── public/             # Web UI (owner.html, portal.html, admin.html)
│   ├── migrations/         # PostgreSQL migrations
│   └── Dockerfile
├── veralux-voice-runtime/  # Voice Runtime service
│   ├── src/                # TypeScript source
│   └── Dockerfile
├── shared/                 # Shared schemas and contracts
│   └── src/
│       └── runtimeContract.ts
├── desktop/                # Electron desktop app
│   ├── assets/icon.png     # VeraLux logo
│   ├── main.js             # Electron main process
│   ├── renderer/           # UI (HTML/CSS/JS)
│   └── start.sh            # Launch script
├── docker-compose.yml      # Service orchestration
├── install.sh              # Interactive installer
├── deploy.sh               # Deployment management
└── .env                    # Environment configuration
```

---

## Building Docker Images

To rebuild images from source after making changes:

```bash
# Build both services
docker compose build control runtime

# Or build individually
docker compose build control
docker compose build runtime

# Restart with new images
COMPOSE_PROJECT_NAME=veralux docker compose up -d control runtime
```

---

## Support

For issues and support:
- Check the troubleshooting section above
- Review logs with `./deploy.sh logs`
- Contact your system administrator

---

## License

See LICENSE file for details.
