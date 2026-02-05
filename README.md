# Veralux Receptionist - Deployment Bundle

This package contains everything needed to deploy Veralux Receptionist using Docker.

## Requirements

- **Docker Engine** 20.10+ with Docker Compose V2
- **Operating System**: Linux (Ubuntu 20.04+) or macOS
- **Ports**: 3000, 5432, 8081-8085 (configurable in `.env`)
- **Disk Space**:
  - Online install: ~2 GB (images pulled from registry)
  - Offline install: ~5 GB+ (includes pre-packaged images)

### GPU Services (Optional)

For GPU-accelerated services (Whisper, Kokoro, XTTS):
- NVIDIA GPU with CUDA support
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

---

## Quick Start (Online)

Use this method if you have internet access and can pull images from the container registry.

```bash
# 1. Unzip the bundle
unzip veralux-receptionist-*-online.zip
cd veralux-receptionist-*/

# 2. Create and configure environment
cp .env.example .env

# 3. Edit .env with your settings (REQUIRED)
#    - Set POSTGRES_PASSWORD to a strong password
#    - Set JWT_SECRET (generate with: openssl rand -base64 32)
#    - Set REGISTRY to your container registry
nano .env  # or use your preferred editor

# 4. Start the application
./deploy.sh up

# 5. Verify it's running
./deploy.sh status
```

---

## Quick Start (Offline / Airgapped)

Use this method for environments without internet access.

```bash
# 1. Unzip the bundle
unzip veralux-receptionist-*-offline.zip
cd veralux-receptionist-*/

# 2. Load Docker images from archive
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

---

## Support

For issues and support:
- Check the troubleshooting section above
- Review logs with `./deploy.sh logs`
- Contact your system administrator

---

## License

See LICENSE file for details.
