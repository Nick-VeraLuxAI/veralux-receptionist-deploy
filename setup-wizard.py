#!/usr/bin/env python3
"""
Veralux Receptionist - Web-based Setup Wizard
Runs a local web server for easy configuration.
"""

import http.server
import json
import os
import secrets
import socketserver
import subprocess
import sys
import threading
import webbrowser
from urllib.parse import parse_qs
import base64

PORT = 8080
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

HTML_PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Veralux Receptionist - Setup</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 24px;
            margin-bottom: 8px;
        }
        
        .header p {
            opacity: 0.9;
            font-size: 14px;
        }
        
        .form-container {
            padding: 30px;
        }
        
        .step {
            margin-bottom: 25px;
        }
        
        .step-header {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .step-number {
            background: #667eea;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            margin-right: 12px;
        }
        
        .step-title {
            font-weight: 600;
            color: #333;
        }
        
        .step-description {
            font-size: 13px;
            color: #666;
            margin-left: 40px;
            margin-bottom: 12px;
        }
        
        .input-group {
            margin-left: 40px;
            margin-bottom: 12px;
        }
        
        label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            color: #555;
            margin-bottom: 6px;
        }
        
        input[type="text"],
        input[type="password"] {
            width: 100%;
            padding: 12px 14px;
            border: 2px solid #e1e1e1;
            border-radius: 8px;
            font-size: 15px;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        input::placeholder {
            color: #aaa;
        }
        
        .help-link {
            font-size: 12px;
            color: #667eea;
            text-decoration: none;
            margin-left: 40px;
            display: inline-block;
            margin-top: 4px;
        }
        
        .help-link:hover {
            text-decoration: underline;
        }
        
        .divider {
            height: 1px;
            background: #eee;
            margin: 25px 0;
        }
        
        .button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        
        .button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        
        .button:active {
            transform: translateY(0);
        }
        
        .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .status {
            display: none;
            margin-top: 20px;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        
        .status.loading {
            display: block;
            background: #e8f4fd;
            color: #1976d2;
        }
        
        .status.success {
            display: block;
            background: #e8f5e9;
            color: #2e7d32;
        }
        
        .status.error {
            display: block;
            background: #ffebee;
            color: #c62828;
        }
        
        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid #1976d2;
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .success-content h3 {
            margin-bottom: 15px;
            color: #2e7d32;
        }
        
        .success-content p {
            margin-bottom: 10px;
        }
        
        .success-content a {
            color: #667eea;
            font-weight: 600;
        }
        
        .success-content .url-box {
            background: #f5f5f5;
            padding: 12px;
            border-radius: 6px;
            margin: 15px 0;
            font-family: monospace;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Veralux Receptionist</h1>
            <p>Setup Wizard</p>
        </div>
        
        <div class="form-container">
            <form id="setupForm">
                <div class="step">
                    <div class="step-header">
                        <div class="step-number">1</div>
                        <div class="step-title">Telnyx Credentials</div>
                    </div>
                    <p class="step-description">Enter your API keys from the Telnyx portal</p>
                    <div class="input-group">
                        <label for="telnyx_api_key">API Key</label>
                        <input type="password" id="telnyx_api_key" name="telnyx_api_key" 
                               placeholder="KEY..." required>
                    </div>
                    <div class="input-group">
                        <label for="telnyx_public_key">Public Key</label>
                        <input type="text" id="telnyx_public_key" name="telnyx_public_key" 
                               placeholder="..." required>
                    </div>
                    <a href="https://portal.telnyx.com" target="_blank" class="help-link">
                        Get your keys at portal.telnyx.com &rarr;
                    </a>
                </div>
                
                <div class="divider"></div>
                
                <div class="step">
                    <div class="step-header">
                        <div class="step-number">2</div>
                        <div class="step-title">Your Domain</div>
                    </div>
                    <p class="step-description">The domain where this will be accessible</p>
                    <div class="input-group">
                        <label for="domain">Domain</label>
                        <input type="text" id="domain" name="domain" 
                               placeholder="receptionist.yourcompany.com" required>
                    </div>
                </div>
                
                <div class="divider"></div>
                
                <button type="submit" class="button" id="submitBtn">
                    Install & Start
                </button>
            </form>
            
            <div class="status" id="status"></div>
            
            <div class="success-content" id="successContent" style="display: none;">
                <h3>Installation Complete!</h3>
                <p>Your Veralux Receptionist is now running.</p>
                <div class="url-box" id="appUrl"></div>
                <p>You can close this window.</p>
                <p style="margin-top: 20px; font-size: 13px; color: #666;">
                    Manage with: <code>./deploy.sh status</code>
                </p>
            </div>
        </div>
    </div>
    
    <script>
        const form = document.getElementById('setupForm');
        const status = document.getElementById('status');
        const submitBtn = document.getElementById('submitBtn');
        const successContent = document.getElementById('successContent');
        const appUrl = document.getElementById('appUrl');
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            submitBtn.disabled = true;
            status.className = 'status loading';
            status.innerHTML = '<span class="spinner"></span> Installing... This may take a minute.';
            
            const formData = new FormData(form);
            const data = Object.fromEntries(formData.entries());
            
            try {
                const response = await fetch('/install', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    status.style.display = 'none';
                    form.style.display = 'none';
                    successContent.style.display = 'block';
                    appUrl.textContent = result.url;
                } else {
                    status.className = 'status error';
                    status.textContent = 'Error: ' + result.error;
                    submitBtn.disabled = false;
                }
            } catch (err) {
                status.className = 'status error';
                status.textContent = 'Connection error. Please try again.';
                submitBtn.disabled = false;
            }
        });
    </script>
</body>
</html>
'''

def generate_secret():
    return secrets.token_urlsafe(32)

def create_env_file(data):
    domain = data['domain']
    if not domain.startswith('http'):
        public_base_url = f"https://{domain}"
    else:
        public_base_url = domain
    
    audio_url = f"{public_base_url}/audio"
    
    env_content = f'''# =============================================================================
# Veralux Receptionist - Configuration
# Generated by Setup Wizard
# =============================================================================

# Version & Registry
VERSION=latest
REGISTRY=ghcr.io/nick-veraluxai

# Database
POSTGRES_USER=veralux
POSTGRES_PASSWORD={generate_secret()}
POSTGRES_DB=veralux

# Security
JWT_SECRET={generate_secret()}

# URLs
BASE_URL={public_base_url}
PUBLIC_BASE_URL={public_base_url}
AUDIO_PUBLIC_BASE_URL={audio_url}

# Ports
CONTROL_PORT=4000
RUNTIME_PORT=4001

# Telnyx
TELNYX_API_KEY={data['telnyx_api_key']}
TELNYX_PUBLIC_KEY={data['telnyx_public_key']}

# Media
MEDIA_STREAM_TOKEN={generate_secret()}
AUDIO_STORAGE_DIR=/app/audio

# Logging
LOG_LEVEL=info

# Speech-to-Text
STT_CHUNK_MS=100
STT_SILENCE_MS=700
DEAD_AIR_MS=10000

# Rate Limiting
GLOBAL_CONCURRENCY_CAP=100
TENANT_CONCURRENCY_CAP_DEFAULT=10
TENANT_CALLS_PER_MIN_CAP_DEFAULT=60
CAPACITY_TTL_SECONDS=3600

# GPU Services (optional)
WHISPER_PORT=9000
WHISPER_MODEL_SIZE=base
KOKORO_PORT=7001
KOKORO_VOICE_ID=default
XTTS_PORT=7002
XTTS_LANGUAGE=en
'''
    
    env_path = os.path.join(SCRIPT_DIR, '.env')
    with open(env_path, 'w') as f:
        f.write(env_content)
    
    return public_base_url

def run_deploy():
    # Check for offline images first
    images_path = os.path.join(SCRIPT_DIR, 'images.tar.zst')
    if os.path.exists(images_path):
        load_script = os.path.join(SCRIPT_DIR, 'load-images.sh')
        subprocess.run([load_script], cwd=SCRIPT_DIR, check=True)
    
    # Run deploy
    deploy_script = os.path.join(SCRIPT_DIR, 'deploy.sh')
    result = subprocess.run(
        [deploy_script, 'up'],
        cwd=SCRIPT_DIR,
        capture_output=True,
        text=True
    )
    
    if result.returncode != 0:
        raise Exception(result.stderr or result.stdout or "Deploy failed")

class SetupHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/' or self.path == '/setup':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())
        else:
            self.send_error(404)
    
    def do_POST(self):
        if self.path == '/install':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode())
            
            try:
                url = create_env_file(data)
                run_deploy()
                
                response = {'success': True, 'url': url}
            except Exception as e:
                response = {'success': False, 'error': str(e)}
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_error(404)
    
    def log_message(self, format, *args):
        pass  # Suppress logging

def open_browser():
    webbrowser.open(f'http://localhost:{PORT}')

def main():
    print()
    print("  ╔═══════════════════════════════════════════════════════════╗")
    print("  ║                                                           ║")
    print("  ║            VERALUX RECEPTIONIST SETUP                     ║")
    print("  ║                                                           ║")
    print("  ╚═══════════════════════════════════════════════════════════╝")
    print()
    print(f"  Opening setup wizard in your browser...")
    print(f"  URL: http://localhost:{PORT}")
    print()
    print("  (Press Ctrl+C to cancel)")
    print()
    
    # Open browser after short delay
    threading.Timer(1.0, open_browser).start()
    
    with socketserver.TCPServer(("", PORT), SetupHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Setup cancelled.")
            sys.exit(0)

if __name__ == '__main__':
    main()
