// src/dev-console.ts

type StatusKind = "info" | "ok" | "err";

const recordBtn = document.getElementById("record-btn") as HTMLButtonElement | null;
const statusEl = document.getElementById("status") as HTMLElement | null;
const rawEl = document.getElementById("last-raw") as HTMLElement | null;

let mediaRecorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let isRecording = false;

function setStatus(text: string, kind: StatusKind = "info") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function logRaw(text: string) {
  if (!rawEl) return;
  rawEl.textContent = text;
}

async function ensureStream(): Promise<MediaStream> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return stream;
  } catch (err) {
    console.error("getUserMedia error:", err);
    setStatus("Mic access denied or unavailable.", "err");
    throw err;
  }
}

function setupRecorder(stream: MediaStream) {
  mediaRecorder = new MediaRecorder(stream);
  chunks = [];

  mediaRecorder.ondataavailable = (e: BlobEvent) => {
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

      logRaw(`Captured ${blob.size} bytes. Sending to /api/dev/receptionist-audio…`);
      await sendToServer(blob);
    } catch (err: any) {
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
    setStatus("Requesting mic access…", "info");

    const stream = await ensureStream();

    if (!mediaRecorder || mediaRecorder.stream !== stream) {
      setupRecorder(stream);
    }

    if (!mediaRecorder) {
      setStatus("MediaRecorder not available in this browser.", "err");
      return;
    }

    recordBtn.classList.add("recording");
    setStatus("Recording… release to send.", "ok");
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
      setStatus("Stopping recording…", "info");
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

async function sendToServer(blob: Blob) {
  setStatus("Sending audio to server…", "info");

  const res = await fetch("/api/dev/receptionist-audio", {
    method: "POST",
    headers: {
      // The server doesn’t actually care about this content-type;
      // it just reads raw bytes and forwards to Whisper.
      "Content-Type": "audio/webm",
    },
    body: blob,
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
  setStatus("Playing reply…", "ok");

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

  console.log("Dev console loaded, wiring events…");
  setStatus("Ready. Hold the button to talk.", "info");

  // Mouse
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

  // Touch
  recordBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      startRecording();
    },
    { passive: false } as AddEventListenerOptions
  );

  recordBtn.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      stopRecording();
    },
    { passive: false } as AddEventListenerOptions
  );

  recordBtn.addEventListener(
    "touchcancel",
    () => {
      if (isRecording) {
        stopRecording();
      }
    },
    { passive: false } as AddEventListenerOptions
  );
}

// Make sure DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireEvents);
} else {
  wireEvents();
}
