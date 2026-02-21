#!/usr/bin/env python3
"""
VeraLux Receptionist — Production Stress Test
Tests: API throughput, concurrent connections, database under load, resource usage.
"""
import json, time, os, sys, subprocess, statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
BASE = "http://127.0.0.1:4000"
RUNTIME = "http://127.0.0.1:4001"

# Read admin key from .env
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
ADMIN_KEY = ""
for line in ENV_PATH.read_text().splitlines():
    if line.startswith("ADMIN_API_KEY="):
        ADMIN_KEY = line.split("=", 1)[1].strip()
        break

HEADERS = {"X-Admin-Key": ADMIN_KEY}

# ── Helpers ─────────────────────────────────────────────────────────────────
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def api_get(url, headers=None, timeout=10):
    """Returns (status_code, latency_ms, body_or_error)"""
    h = dict(HEADERS)
    if headers:
        h.update(headers)
    req = Request(url, headers=h)
    start = time.monotonic()
    try:
        resp = urlopen(req, timeout=timeout)
        body = resp.read().decode()
        ms = (time.monotonic() - start) * 1000
        return resp.status, ms, body
    except HTTPError as e:
        ms = (time.monotonic() - start) * 1000
        return e.code, ms, str(e)
    except Exception as e:
        ms = (time.monotonic() - start) * 1000
        return 0, ms, str(e)

def docker_stats():
    """Get current CPU/memory for all veralux containers."""
    result = subprocess.run(
        ["docker", "stats", "--no-stream", "--format",
         "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"],
        capture_output=True, text=True, timeout=10
    )
    lines = []
    for line in result.stdout.strip().split("\n"):
        if line.startswith("veralux-"):
            lines.append(line)
    return lines

def print_header(title):
    print(f"\n{BOLD}{CYAN}{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}{RESET}\n")

def print_result(label, passed, detail=""):
    icon = f"{GREEN}PASS{RESET}" if passed else f"{RED}FAIL{RESET}"
    print(f"  [{icon}] {label}  {detail}")

def print_latency_stats(latencies, label=""):
    if not latencies:
        return
    p50 = statistics.median(latencies)
    p95 = sorted(latencies)[int(len(latencies) * 0.95)] if len(latencies) >= 20 else max(latencies)
    p99 = sorted(latencies)[int(len(latencies) * 0.99)] if len(latencies) >= 100 else max(latencies)
    avg = statistics.mean(latencies)
    mn = min(latencies)
    mx = max(latencies)
    print(f"  {YELLOW}{label}Latency (ms):{RESET} avg={avg:.0f}  p50={p50:.0f}  p95={p95:.0f}  p99={p99:.0f}  min={mn:.0f}  max={mx:.0f}")

# ── Tests ───────────────────────────────────────────────────────────────────

def test_health_endpoints():
    """Test that all health endpoints respond quickly."""
    print_header("1. Health Endpoint Responsiveness")
    endpoints = [
        ("Control Plane", f"{BASE}/health"),
        ("Runtime", f"{RUNTIME}/health/live"),
    ]
    all_pass = True
    for name, url in endpoints:
        status, ms, body = api_get(url)
        ok = status == 200 and ms < 500
        if not ok:
            all_pass = False
        print_result(f"{name}", ok, f"{ms:.0f}ms  HTTP {status}")
    return all_pass

def test_api_throughput():
    """Blast the admin API with concurrent requests and measure throughput."""
    print_header("2. API Throughput (concurrent requests)")

    url = f"{BASE}/api/admin/tenants"
    num_requests = 200
    concurrency = 20

    latencies = []
    errors = 0
    rate_limited = 0
    start = time.monotonic()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(api_get, url) for _ in range(num_requests)]
        for f in as_completed(futures):
            status, ms, body = f.result()
            if status == 200:
                latencies.append(ms)
            elif status == 429:
                rate_limited += 1
            else:
                errors += 1

    elapsed = time.monotonic() - start
    rps = len(latencies) / elapsed if elapsed > 0 else 0

    print(f"  Requests: {num_requests}  |  Concurrency: {concurrency}  |  Duration: {elapsed:.1f}s")
    print(f"  {GREEN}Success: {len(latencies)}{RESET}  |  {YELLOW}Rate-limited: {rate_limited}{RESET}  |  {RED}Errors: {errors}{RESET}")
    print(f"  Throughput: {BOLD}{rps:.1f} req/s{RESET}")
    print_latency_stats(latencies)

    ok = errors == 0 and len(latencies) > 0
    print_result("No hard errors", errors == 0)
    print_result("Throughput > 10 req/s", rps > 10, f"({rps:.1f})")
    return ok

def test_database_under_load():
    """Hit endpoints that query the database concurrently."""
    print_header("3. Database Under Load (leads + workflows)")

    urls = [
        f"{BASE}/api/admin/tenants",
        f"{BASE}/api/admin/leads?limit=50",
        f"{BASE}/api/admin/workflows",
    ]

    num_per_endpoint = 50
    concurrency = 15
    latencies = []
    errors = 0

    def hit(url):
        # Owner endpoints need tenant context
        extra = {}
        if "/leads" in url or "/workflows" in url:
            extra = {"X-Tenant-ID": "King-Sod"}
        return api_get(url, headers=extra)

    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        tasks = []
        for url in urls:
            for _ in range(num_per_endpoint):
                tasks.append(pool.submit(hit, url))
        for f in as_completed(tasks):
            status, ms, body = f.result()
            if status == 200:
                latencies.append(ms)
            elif status != 429:  # ignore rate limits
                errors += 1

    elapsed = time.monotonic() - start
    total = num_per_endpoint * len(urls)
    rps = len(latencies) / elapsed if elapsed > 0 else 0

    print(f"  Endpoints: {len(urls)}  |  Requests: {total}  |  Concurrency: {concurrency}  |  Duration: {elapsed:.1f}s")
    print(f"  {GREEN}Success: {len(latencies)}{RESET}  |  {RED}Errors: {errors}{RESET}  |  Throughput: {rps:.1f} req/s")
    print_latency_stats(latencies)

    ok = errors == 0
    print_result("No database errors", ok)
    print_result("p95 < 500ms", (sorted(latencies)[int(len(latencies)*0.95)] if latencies else 999) < 500)
    return ok

def test_sustained_load():
    """Sustained load over 30 seconds — watch for degradation."""
    print_header("4. Sustained Load (30 seconds)")

    url = f"{BASE}/health"
    duration = 30
    concurrency = 10
    running = True
    latencies = []
    errors = 0

    def worker():
        nonlocal errors
        while running:
            status, ms, _ = api_get(url, timeout=5)
            if status == 200:
                latencies.append(ms)
            else:
                errors += 1
            time.sleep(0.05)  # ~20 req/s per worker

    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(worker) for _ in range(concurrency)]
        time.sleep(duration)
        running = False
        for f in futures:
            f.result()

    elapsed = time.monotonic() - start
    rps = len(latencies) / elapsed if elapsed > 0 else 0

    # Check for degradation: compare first 10s vs last 10s
    third = len(latencies) // 3
    if third > 10:
        early_avg = statistics.mean(latencies[:third])
        late_avg = statistics.mean(latencies[-third:])
        degradation = (late_avg - early_avg) / early_avg * 100 if early_avg > 0 else 0
    else:
        degradation = 0

    print(f"  Duration: {elapsed:.0f}s  |  Total requests: {len(latencies)}  |  Errors: {errors}")
    print(f"  Throughput: {BOLD}{rps:.1f} req/s{RESET}")
    print_latency_stats(latencies)
    print(f"  Degradation (early vs late avg): {degradation:+.1f}%")

    print_result("No errors during sustained load", errors == 0)
    print_result("No significant degradation (<50%)", abs(degradation) < 50, f"({degradation:+.1f}%)")
    print_result("Sustained throughput > 50 req/s", rps > 50, f"({rps:.1f})")
    return errors == 0 and abs(degradation) < 50

def test_connection_limits():
    """Open many concurrent connections to test connection handling."""
    print_header("5. Connection Limits (100 simultaneous)")

    url = f"{BASE}/health"
    concurrency = 100
    latencies = []
    errors = 0

    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(api_get, url, None, 10) for _ in range(concurrency)]
        for f in as_completed(futures):
            status, ms, _ = f.result()
            if status == 200:
                latencies.append(ms)
            else:
                errors += 1

    elapsed = time.monotonic() - start

    print(f"  Concurrent connections: {concurrency}  |  Duration: {elapsed:.1f}s")
    print(f"  {GREEN}Success: {len(latencies)}{RESET}  |  {RED}Failed: {errors}{RESET}")
    print_latency_stats(latencies)

    print_result("All connections handled", errors == 0, f"({len(latencies)}/{concurrency})")
    print_result("Max latency < 5s", (max(latencies) if latencies else 9999) < 5000)
    return errors == 0

def show_resource_usage():
    """Show Docker container resource usage."""
    print_header("6. Resource Usage (post-test snapshot)")
    stats = docker_stats()
    if not stats:
        print("  Could not read Docker stats.")
        return
    print(f"  {'Container':<25} {'CPU':>8} {'Memory':>20} {'Mem%':>6}")
    print(f"  {'-'*25} {'-'*8} {'-'*20} {'-'*6}")
    for line in sorted(stats):
        parts = line.split("\t")
        if len(parts) >= 4:
            print(f"  {parts[0]:<25} {parts[1]:>8} {parts[2]:>20} {parts[3]:>6}")

# ── Main ────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{BOLD}{CYAN}╔══════════════════════════════════════════════════════════════════════╗")
    print(f"║            VeraLux Receptionist — Stress Test Suite                 ║")
    print(f"╚══════════════════════════════════════════════════════════════════════╝{RESET}")
    print(f"  Target: {BASE}")
    print(f"  Admin key: {'configured' if ADMIN_KEY else 'MISSING'}")
    print(f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    results = {}
    results["health"] = test_health_endpoints()
    results["throughput"] = test_api_throughput()
    results["database"] = test_database_under_load()
    results["sustained"] = test_sustained_load()
    results["connections"] = test_connection_limits()
    show_resource_usage()

    # ── Summary ──
    print_header("SUMMARY")
    total = len(results)
    passed = sum(1 for v in results.values() if v)
    for name, ok in results.items():
        print_result(name, ok)

    print(f"\n  {BOLD}Result: {passed}/{total} test suites passed{RESET}")
    if passed == total:
        print(f"  {GREEN}{BOLD}System is handling load well.{RESET}\n")
    else:
        print(f"  {YELLOW}{BOLD}Some tests need attention — review above.{RESET}\n")

    return 0 if passed == total else 1

if __name__ == "__main__":
    sys.exit(main())
