# Observability

The runtime exposes Prometheus metrics, structured logs, and health endpoints for monitoring.

## Metrics Endpoint

```
GET /metrics
```

Returns Prometheus-format metrics including:

| Metric | Type | Description |
|--------|------|-------------|
| `veralux_http_requests_total` | counter | Total HTTP requests by method, path, status |
| `veralux_http_request_duration_seconds` | histogram | Request latency |
| `veralux_active_calls` | gauge | Current active call sessions |
| `veralux_inbound_audio_frames_total` | counter | Audio frames received |
| `veralux_inbound_audio_frames_dropped_total` | counter | Audio frames dropped (by reason) |
| `veralux_stt_requests_total` | counter | STT requests by status |
| `veralux_stt_duration_seconds` | histogram | STT request latency |
| `veralux_tts_requests_total` | counter | TTS requests by status |
| `veralux_tts_duration_seconds` | histogram | TTS request latency |
| `veralux_brain_requests_total` | counter | Brain/LLM requests by status |
| `veralux_brain_duration_seconds` | histogram | Brain request latency |

## Health Endpoints

### Liveness Probe
```
GET /health/live
```
Returns 200 if the process is running. Use for Kubernetes liveness probe.

### Readiness Probe
```
GET /health/ready
```
Returns 200 if Redis is connected. Use for Kubernetes readiness probe.

### Full Health Check
```
GET /health
```
Returns detailed health status including Redis, Whisper, and TTS connectivity:

```json
{
  "status": "ok",
  "checks": {
    "redis": { "ok": true, "latency_ms": 2 },
    "whisper": { "ok": true, "latency_ms": 45 },
    "tts": { "ok": true, "latency_ms": 12 }
  },
  "uptime_seconds": 3600
}
```

Status values:
- `ok`: All checks pass
- `degraded`: Non-critical checks failing (Whisper/TTS)
- `unhealthy`: Redis is down (returns 503)

## Structured Logging

Logs are JSON-formatted (pino) with consistent fields:

```json
{
  "level": 30,
  "time": 1699900000000,
  "msg": "call session created",
  "event": "call_session_created",
  "call_control_id": "call_abc123",
  "tenant_id": "tenant-1",
  "requestId": "req_xyz"
}
```

Key log events:
- `call_session_created` / `call_session_ended`
- `stt_final` / `stt_partial`
- `tts_synthesize_start` / `tts_synthesize_done`
- `brain_reply_start` / `brain_reply_done`
- `playback_started` / `playback_ended`
- `health_check_degraded`

Set `LOG_LEVEL` env var to control verbosity (`debug`, `info`, `warn`, `error`).

## Example Prometheus Alerts

```yaml
groups:
  - name: veralux
    rules:
      # Alert if no calls in 15 minutes during business hours
      - alert: NoActiveCalls
        expr: veralux_active_calls == 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "No active calls for 15 minutes"

      # Alert on high error rate
      - alert: HighErrorRate
        expr: |
          sum(rate(veralux_http_requests_total{status=~"5.."}[5m]))
          / sum(rate(veralux_http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "HTTP error rate above 5%"

      # Alert on STT failures
      - alert: STTFailures
        expr: |
          sum(rate(veralux_stt_requests_total{status="error"}[5m]))
          / sum(rate(veralux_stt_requests_total[5m])) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "STT error rate above 10%"

      # Alert on slow STT
      - alert: SlowSTT
        expr: |
          histogram_quantile(0.95, rate(veralux_stt_duration_seconds_bucket[5m])) > 2
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "STT p95 latency above 2 seconds"

      # Alert on TTS failures
      - alert: TTSFailures
        expr: |
          sum(rate(veralux_tts_requests_total{status="error"}[5m]))
          / sum(rate(veralux_tts_requests_total[5m])) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "TTS error rate above 10%"

      # Alert on Redis down
      - alert: RedisDown
        expr: veralux_redis_connected == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis connection lost"

      # Alert on high audio frame drop rate
      - alert: HighAudioDropRate
        expr: |
          sum(rate(veralux_inbound_audio_frames_dropped_total[5m]))
          / sum(rate(veralux_inbound_audio_frames_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Audio frame drop rate above 5%"

      # Alert on graceful shutdown taking too long
      - alert: ShutdownStuck
        expr: veralux_shutdown_in_progress == 1
        for: 60s
        labels:
          severity: critical
        annotations:
          summary: "Graceful shutdown taking over 60 seconds"
```

## Grafana Dashboard

Import the following panels for a basic dashboard:

1. **Active Calls** - `veralux_active_calls`
2. **Request Rate** - `rate(veralux_http_requests_total[1m])`
3. **Error Rate** - `rate(veralux_http_requests_total{status=~"5.."}[1m])`
4. **STT Latency p95** - `histogram_quantile(0.95, rate(veralux_stt_duration_seconds_bucket[5m]))`
5. **TTS Latency p95** - `histogram_quantile(0.95, rate(veralux_tts_duration_seconds_bucket[5m]))`
6. **Brain Latency p95** - `histogram_quantile(0.95, rate(veralux_brain_duration_seconds_bucket[5m]))`
7. **Audio Frame Drop Rate** - `rate(veralux_inbound_audio_frames_dropped_total[1m])`

## Kubernetes Integration

Example deployment with probes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: veralux-runtime
spec:
  template:
    spec:
      containers:
        - name: runtime
          image: veralux/runtime:latest
          ports:
            - containerPort: 3000
          livenessProbe:
            httpGet:
              path: /health/live
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]  # Allow time for load balancer to drain
      terminationGracePeriodSeconds: 45  # Match SHUTDOWN_TIMEOUT_MS + buffer
```
