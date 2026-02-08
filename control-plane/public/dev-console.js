// src/dev-console.ts
var recordBtn = document.getElementById("record-btn");
var statusEl = document.getElementById("status");
var rawEl = document.getElementById("last-raw");
var mediaRecorder = null;
var chunks = [];
var isRecording = false;
function setStatus(text, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}
function logRaw(text) {
  if (!rawEl) return;
  rawEl.textContent = text;
}
async function ensureStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return stream;
  } catch (err) {
    console.error("getUserMedia error:", err);
    setStatus("Mic access denied or unavailable.", "err");
    throw err;
  }
}
function setupRecorder(stream) {
  mediaRecorder = new MediaRecorder(stream);
  chunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };
  mediaRecorder.onstop = async () => {
    try {
      if (!chunks.length) {
        setStatus("No audio captured.", "err");
        return;
      }
      const blob = new Blob(chunks, { type: "audio/webm" });
      chunks = [];
      logRaw(`Captured ${blob.size} bytes. Sending to /api/dev/receptionist-audio\u2026`);
      await sendToServer(blob);
    } catch (err) {
      console.error("onstop/sendToServer error:", err);
      setStatus(`Error: ${String(err)}`, "err");
      logRaw(String(err));
    }
  };
}
async function startRecording() {
  if (isRecording) return;
  isRecording = true;
  if (!recordBtn) return;
  try {
    setStatus("Requesting mic access\u2026", "info");
    const stream = await ensureStream();
    if (!mediaRecorder || mediaRecorder.stream !== stream) {
      setupRecorder(stream);
    }
    if (!mediaRecorder) {
      setStatus("MediaRecorder not available in this browser.", "err");
      return;
    }
    recordBtn.classList.add("recording");
    setStatus("Recording\u2026 release to send.", "ok");
    mediaRecorder.start();
  } catch (err) {
    console.error("startRecording error:", err);
    isRecording = false;
    recordBtn.classList.remove("recording");
    setStatus("Failed to start recording.", "err");
  }
}
async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  if (!recordBtn) return;
  try {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      setStatus("Stopping recording\u2026", "info");
      mediaRecorder.stop();
    } else {
      setStatus("Recorder not in recording state.", "err");
    }
  } catch (err) {
    console.error("stopRecording error:", err);
    setStatus("Failed to stop recording.", "err");
  } finally {
    recordBtn.classList.remove("recording");
  }
}
async function sendToServer(blob) {
  setStatus("Sending audio to server\u2026", "info");
  const res = await fetch("/api/dev/receptionist-audio", {
    method: "POST",
    headers: {
      // The server doesn’t actually care about this content-type;
      // it just reads raw bytes and forwards to Whisper.
      "Content-Type": "audio/webm"
    },
    body: blob
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = `Server error: ${res.status} ${res.statusText} ${text}`;
    console.error(msg);
    setStatus("Server returned an error.", "err");
    logRaw(msg);
    return;
  }
  const arrayBuf = await res.arrayBuffer();
  const replyBlob = new Blob([arrayBuf], { type: "audio/wav" });
  const url = URL.createObjectURL(replyBlob);
  logRaw(`Received ${arrayBuf.byteLength} bytes of WAV audio from server.`);
  setStatus("Playing reply\u2026", "ok");
  const audio = new Audio(url);
  audio.play().catch((err) => {
    console.error("Audio play error:", err);
    setStatus("Failed to play reply audio.", "err");
  });
}
function wireEvents() {
  if (!recordBtn) {
    console.error("Dev console: #record-btn not found in DOM.");
    return;
  }
  console.log("Dev console loaded, wiring events\u2026");
  setStatus("Ready. Hold the button to talk.", "info");
  recordBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startRecording();
  });
  recordBtn.addEventListener("mouseup", (e) => {
    e.preventDefault();
    stopRecording();
  });
  recordBtn.addEventListener("mouseleave", () => {
    if (isRecording) {
      stopRecording();
    }
  });
  recordBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      startRecording();
    },
    { passive: false }
  );
  recordBtn.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      stopRecording();
    },
    { passive: false }
  );
  recordBtn.addEventListener(
    "touchcancel",
    () => {
      if (isRecording) {
        stopRecording();
      }
    },
    { passive: false }
  );
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireEvents);
} else {
  wireEvents();
}
