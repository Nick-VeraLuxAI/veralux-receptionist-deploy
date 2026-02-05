#!/usr/bin/env python3
"""
Veralux Receptionist - Web-based Setup Wizard
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
import base64

PORT = 8080
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# TODO: Update this to your actual API endpoint
API_BASE_URL = "https://api.veralux.ai"

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
            max-width: 480px;
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
        
        .tabs {
            display: flex;
            margin-bottom: 25px;
            border-bottom: 2px solid #eee;
        }
        
        .tab {
            flex: 1;
            padding: 12px;
            text-align: center;
            cursor: pointer;
            font-weight: 500;
            color: #888;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
            transition: all 0.2s;
        }
        
        .tab:hover {
            color: #667eea;
        }
        
        .tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .input-group {
            margin-bottom: 20px;
        }
        
        label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            color: #555;
            margin-bottom: 6px;
        }
        
        input[type="text"],
        input[type="email"],
        input[type="password"],
        textarea {
            width: 100%;
            padding: 12px 14px;
            border: 2px solid #e1e1e1;
            border-radius: 8px;
            font-size: 15px;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        
        textarea {
            min-height: 120px;
            font-family: monospace;
            font-size: 13px;
        }
        
        input:focus, textarea:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        input::placeholder, textarea::placeholder {
            color: #aaa;
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
        
        .help-text {
            font-size: 13px;
            color: #888;
            margin-top: 8px;
        }
        
        .divider {
            display: flex;
            align-items: center;
            margin: 20px 0;
            color: #888;
            font-size: 13px;
        }
        
        .divider::before,
        .divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: #e1e1e1;
        }
        
        .divider span {
            padding: 0 15px;
        }
        
        .success-content {
            text-align: center;
        }
        
        .success-content h3 {
            margin-bottom: 15px;
            color: #2e7d32;
        }
        
        .success-content p {
            margin-bottom: 10px;
            color: #555;
        }
        
        .success-content .checkmark {
            font-size: 48px;
            margin-bottom: 15px;
        }
        
        .info-box {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
            color: #555;
        }
        
        .info-box strong {
            color: #333;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Veralux Receptionist</h1>
            <p>Setup Wizard</p>
        </div>
        
        <div class="form-container" id="formContainer">
            <div class="tabs">
                <div class="tab active" data-tab="online">Online Setup</div>
                <div class="tab" data-tab="offline">Offline Setup</div>
            </div>
            
            <!-- Online Setup Tab -->
            <div class="tab-content active" id="online-tab">
                <div class="info-box">
                    Log in with the email and password you created during signup.
                </div>
                
                <form id="onlineForm">
                    <div class="input-group">
                        <label for="email">Email Address</label>
                        <input type="email" id="email" name="email" 
                               placeholder="you@company.com" required>
                    </div>
                    
                    <div class="input-group">
                        <label for="password">Password</label>
                        <input type="password" id="password" name="password" 
                               placeholder="Your account password" required>
                    </div>
                    
                    <button type="submit" class="button" id="onlineBtn">
                        Log In & Configure
                    </button>
                </form>
                
                <p class="help-text" style="text-align: center; margin-top: 15px;">
                    Don't have an account? <a href="https://veralux.ai/signup" target="_blank">Sign up here</a>
                </p>
            </div>
            
            <!-- Offline Setup Tab -->
            <div class="tab-content" id="offline-tab">
                <div class="info-box">
                    Enter the configuration details from the email you received after signup.
                </div>
                
                <form id="offlineForm">
                    <div class="input-group">
                        <label for="setup_code">Setup Code</label>
                        <textarea id="setup_code" name="setup_code" 
                                  placeholder="Paste your setup code from the email..."></textarea>
                        <p class="help-text">This is the encoded configuration block from your welcome email.</p>
                    </div>
                    
                    <button type="submit" class="button" id="offlineBtn">
                        Configure System
                    </button>
                </form>
                
                <div class="divider"><span>or enter manually</span></div>
                
                <form id="manualForm">
                    <div class="input-group">
                        <label for="api_key">API Key</label>
                        <input type="text" id="api_key" name="api_key" placeholder="vx_...">
                    </div>
                    
                    <div class="input-group">
                        <label for="telnyx_number">Telnyx Phone Number</label>
                        <input type="text" id="telnyx_number" name="telnyx_number" placeholder="+1...">
                    </div>
                    
                    <div class="input-group">
                        <label for="telnyx_api_key">Telnyx API Key</label>
                        <input type="password" id="telnyx_api_key" name="telnyx_api_key" placeholder="KEY...">
                    </div>
                    
                    <div class="input-group">
                        <label for="telnyx_public_key">Telnyx Public Key</label>
                        <input type="text" id="telnyx_public_key" name="telnyx_public_key" placeholder="...">
                    </div>
                    
                    <div class="input-group">
                        <label for="openai_api_key">OpenAI API Key</label>
                        <input type="password" id="openai_api_key" name="openai_api_key" placeholder="sk-...">
                    </div>
                    
                    <div class="input-group">
                        <label for="jwt_secret">Your Password (JWT Secret)</label>
                        <input type="password" id="jwt_secret" name="jwt_secret" placeholder="The password you created">
                    </div>
                    
                    <button type="submit" class="button">
                        Configure System
                    </button>
                </form>
            </div>
            
            <div class="status" id="status"></div>
        </div>
        
        <div class="form-container" id="successContainer" style="display: none;">
            <div class="success-content">
                <div class="checkmark">✓</div>
                <h3>Setup Complete!</h3>
                <p>Your Veralux Receptionist is now running.</p>
                <p style="margin-top: 20px; font-size: 13px; color: #666;">
                    You can close this window.<br><br>
                    Manage with: <code>./deploy.sh status</code>
                </p>
            </div>
        </div>
    </div>
    
    <script>
        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
            });
        });
        
        const status = document.getElementById('status');
        const formContainer = document.getElementById('formContainer');
        const successContainer = document.getElementById('successContainer');
        
        function showLoading(message) {
            status.className = 'status loading';
            status.innerHTML = '<span class="spinner"></span> ' + message;
        }
        
        function showError(message) {
            status.className = 'status error';
            status.textContent = message;
        }
        
        function showSuccess() {
            formContainer.style.display = 'none';
            successContainer.style.display = 'block';
        }
        
        async function submitConfig(data) {
            showLoading('Configuring system...');
            
            try {
                const response = await fetch('/install', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showSuccess();
                } else {
                    showError('Error: ' + result.error);
                }
            } catch (err) {
                showError('Connection error. Please try again.');
            }
        }
        
        // Online form - login to API
        document.getElementById('onlineForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            showLoading('Logging in...');
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            
            try {
                // Call the local server which will proxy to the API
                const response = await fetch('/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showLoading('Configuring system...');
                    await submitConfig(result.config);
                } else {
                    showError(result.error || 'Login failed. Please check your credentials.');
                }
            } catch (err) {
                showError('Connection error. Please try again.');
            }
        });
        
        // Offline form - setup code
        document.getElementById('offlineForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const setupCode = document.getElementById('setup_code').value.trim();
            if (!setupCode) {
                showError('Please enter your setup code.');
                return;
            }
            
            try {
                // Decode the setup code (base64 JSON)
                const config = JSON.parse(atob(setupCode));
                await submitConfig(config);
            } catch (err) {
                showError('Invalid setup code. Please check and try again.');
            }
        });
        
        // Manual form
        document.getElementById('manualForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const config = {
                api_key: document.getElementById('api_key').value,
                telnyx_number: document.getElementById('telnyx_number').value,
                telnyx_api_key: document.getElementById('telnyx_api_key').value,
                telnyx_public_key: document.getElementById('telnyx_public_key').value,
                openai_api_key: document.getElementById('openai_api_key').value,
                jwt_secret: document.getElementById('jwt_secret').value
            };
            
            // Validate
            const missing = Object.entries(config).filter(([k, v]) => !v).map(([k]) => k);
            if (missing.length > 0) {
                showError('Please fill in all fields.');
                return;
            }
            
            await submitConfig(config);
        });
    </script>
</body>
</html>
'''

def generate_secret():
    return secrets.token_urlsafe(32)

def create_env_file(data):
    """Create .env file from configuration data."""
    
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
JWT_SECRET={data.get('jwt_secret', generate_secret())}
API_KEY={data.get('api_key', '')}

# Telnyx
TELNYX_API_KEY={data.get('telnyx_api_key', '')}
TELNYX_PUBLIC_KEY={data.get('telnyx_public_key', '')}
TELNYX_PHONE_NUMBER={data.get('telnyx_number', '')}

# OpenAI
OPENAI_API_KEY={data.get('openai_api_key', '')}

# Ports
CONTROL_PORT=4000
RUNTIME_PORT=4001

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

def run_deploy():
    """Load images if offline, then start services."""
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

def fetch_config_from_api(email, password):
    """
    Fetch configuration from the Veralux API.
    TODO: Implement actual API call to your backend.
    """
    import urllib.request
    import urllib.error
    
    try:
        url = f"{API_BASE_URL}/api/v1/installer/config"
        data = json.dumps({"email": email, "password": password}).encode()
        
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"}
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode())
            return result
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return {"success": False, "error": "Invalid email or password."}
        elif e.code == 404:
            return {"success": False, "error": "Account not found. Please sign up first."}
        else:
            return {"success": False, "error": f"Server error: {e.code}"}
    except urllib.error.URLError as e:
        return {"success": False, "error": "Could not connect to server. Check your internet connection."}
    except Exception as e:
        return {"success": False, "error": str(e)}

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
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        data = json.loads(post_data.decode())
        
        if self.path == '/login':
            # Fetch config from API
            result = fetch_config_from_api(data['email'], data['password'])
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            
        elif self.path == '/install':
            try:
                create_env_file(data)
                run_deploy()
                response = {'success': True}
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
