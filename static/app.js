const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const micBtn = document.getElementById("mic-btn");
const statusEl = document.getElementById("status");
const voiceToggle = document.getElementById("voice-toggle");
const modeButtons = document.querySelectorAll(".mode-btn");
const modeDescEl = document.getElementById("mode-desc");
const genderButtons = document.querySelectorAll(".gender-btn");
const heyFlowBtn = document.getElementById("heyflow-toggle");

const MODE_DESCRIPTIONS = {
  friend: "Short, casual replies — like talking to a friend.",
  standard: "Full, structured answers — like a normal AI assistant.",
};

let history = [];
let voiceOn = true;
let mode = "friend";
let voiceGender = localStorage.getItem("dattasflow_voice_gender") || "female";
let ttsSpeaking = false;

function addBubble(role, text) {
  const row = document.createElement("div");
  row.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

// --- Voice gender selection ---
// SpeechSynthesisVoice has no standard "gender" field, so we match on common
// voice-name patterns across Chrome/Edge/Safari. Falls back to whatever's
// available if nothing matches.
const FEMALE_VOICE_HINTS = ["female", "zira", "samantha", "victoria", "susan", "karen", "moira", "tessa", "fiona", "aria", "jenny", "google us english"];
const MALE_VOICE_HINTS = ["male", "david", "mark", "alex", "daniel", "fred", "guy", "ryan", "google uk english male"];

function pickVoice(gender) {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const hints = gender === "male" ? MALE_VOICE_HINTS : FEMALE_VOICE_HINTS;
  const englishVoices = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = englishVoices.length ? englishVoices : voices;
  return pool.find((v) => hints.some((h) => v.name.toLowerCase().includes(h))) || pool[0];
}

genderButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    voiceGender = btn.dataset.gender;
    localStorage.setItem("dattasflow_voice_gender", voiceGender);
    genderButtons.forEach((b) => b.classList.toggle("active", b === btn));
  });
});
genderButtons.forEach((b) => b.classList.toggle("active", b.dataset.gender === voiceGender));

function speak(text) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
  const voice = pickVoice(voiceGender);
  if (voice) utter.voice = voice;

  // Pause Hey Flow listening while speaking so the mic doesn't pick up
  // the assistant's own voice and re-trigger itself.
  ttsSpeaking = true;
  if (heyFlowActive && heyFlowRecognizer) {
    try { heyFlowRecognizer.stop(); } catch (e) { /* not running */ }
  }
  utter.onend = utter.onerror = () => {
    ttsSpeaking = false;
    if (heyFlowActive) startHeyFlowRecognizer();
  };
  window.speechSynthesis.speak(utter);
}

async function sendMessage(text) {
  if (!text.trim()) return;
  addBubble("user", text);
  inputEl.value = "";
  statusEl.textContent = "Thinking...";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history, mode }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();

    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: data.reply });

    addBubble("assistant", data.reply);
    statusEl.textContent = data.used_search ? "Answered with live web results" : "";
    speak(data.reply);
  } catch (err) {
    addBubble("assistant", "Sorry, something went wrong reaching the model. Check the server logs.");
    statusEl.textContent = "";
    console.error(err);
  }
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
});

voiceToggle.addEventListener("click", () => {
  voiceOn = !voiceOn;
  voiceToggle.textContent = voiceOn ? "🔊 Voice on" : "🔇 Voice off";
  if (!voiceOn) window.speechSynthesis.cancel();
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    modeButtons.forEach((b) => b.classList.toggle("active", b === btn));
    modeDescEl.textContent = MODE_DESCRIPTIONS[mode];
  });
});

// --- Manual mic: real push-to-talk recording, transcribed server-side by
// NVIDIA Riva (Parakeet ASR) instead of the browser's built-in speech
// recognition, which is noticeably worse at accuracy and gives no way to
// know if it actually heard you. Tap to start, tap again to stop — no
// silence-detection guessing about when you're done talking. ---
let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let silentGain = null;
let recordedChunks = [];
let isRecording = false;
let recordTimeoutId = null;
const MAX_RECORD_SECONDS = 45;

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function buildWavBlob(chunks, sampleRate) {
  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;
  const pcm = new Float32Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  const pcm16 = floatTo16BitPCM(pcm);

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm16.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm16.byteLength, true);

  return new Blob([header, pcm16], { type: "audio/wav" });
}

function updateLevelMeter(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / data.length);
  const level = Math.min(1, rms * 6);
  micBtn.style.boxShadow = `0 0 0 ${4 + level * 16}px rgba(217,98,43,${0.15 + level * 0.4})`;
}

async function startRecording() {
  if (typeof heyFlowActive !== "undefined" && heyFlowActive) stopHeyFlow();

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
  silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  recordedChunks = [];

  processorNode.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    recordedChunks.push(new Float32Array(data));
    updateLevelMeter(data);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  isRecording = true;
  micBtn.classList.add("listening");
  statusEl.textContent = "Recording — tap the mic again when you're done";

  recordTimeoutId = setTimeout(stopRecordingAndTranscribe, MAX_RECORD_SECONDS * 1000);
}

async function stopRecordingAndTranscribe() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(recordTimeoutId);
  micBtn.classList.remove("listening");
  micBtn.style.boxShadow = "";

  try {
    processorNode.disconnect();
    sourceNode.disconnect();
    silentGain.disconnect();
  } catch (e) { /* already disconnected */ }
  mediaStream.getTracks().forEach((t) => t.stop());
  const sampleRate = audioCtx.sampleRate;
  await audioCtx.close();

  if (!recordedChunks.length) {
    statusEl.textContent = "";
    return;
  }

  statusEl.textContent = "Transcribing...";
  const wavBlob = buildWavBlob(recordedChunks, sampleRate);
  recordedChunks = [];

  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBlob,
    });
    if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
    const data = await res.json();
    if (data.transcript && data.transcript.trim()) {
      sendMessage(data.transcript.trim());
    } else {
      statusEl.textContent = "Didn't catch that — try again?";
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Transcription failed. Try again?";
  }
}

const toggleMic = async () => {
  if (isRecording) {
    stopRecordingAndTranscribe();
    return;
  }
  try {
    await startRecording();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't access the microphone.";
  }
};

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  micBtn.addEventListener("click", toggleMic);
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      toggleMic();
    }
  });
} else {
  micBtn.disabled = true;
  micBtn.title = "Microphone recording isn't supported in this browser";
}

// --- "Hey Flow" hands-free wake phrase (continuous listening) ---
// This still uses the browser's built-in speech recognition, not Riva:
// it's just spotting a trigger word, not transcribing content, so the
// lower accuracy doesn't matter and running it continuously through a
// paid cloud ASR service would be wasteful. Real background wake-word
// detection (like "Hey Siri") needs a native app; a web page can only
// listen while it's open, in the foreground, and the screen is on.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let heyFlowActive = false;
let heyFlowRecognizer = null;

if (SpeechRecognition) {
  const WAKE_PATTERN = /^(hey|hi|hi there|ok|okay)[,.\s]+flow\b[,:.\s]*/i;
  const AWAIT_QUERY_MS = 7000;

  // Real-world usage is almost always "Hey Flow" ...(brief pause)... "what's
  // the weather" -- the browser splits that into two separate recognized
  // chunks. This state tracks "wake phrase heard, now waiting for the
  // actual question to arrive as the next chunk" so those two get stitched
  // together instead of only working when said in one unbroken breath.
  let awaitingQuery = false;
  let awaitingQueryTimeout = null;

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
      osc.onended = () => ctx.close();
    } catch (e) { /* audio not available, non-critical */ }
  }

  function armAwaitingQuery() {
    awaitingQuery = true;
    statusEl.textContent = "I'm listening, go ahead...";
    beep();
    clearTimeout(awaitingQueryTimeout);
    awaitingQueryTimeout = setTimeout(() => {
      if (awaitingQuery) {
        awaitingQuery = false;
        if (heyFlowActive) statusEl.textContent = 'Listening for "Hey Flow"...';
      }
    }, AWAIT_QUERY_MS);
  }

  function buildHeyFlowRecognizer() {
    const r = new SpeechRecognition();
    r.lang = "en-US";
    // Non-continuous, auto-restarted on every end (see onend below) instead
    // of continuous:true -- continuous mode is notoriously flaky across
    // browsers, especially on mobile, where it silently stops working.
    // Short restarted sessions are more reliable in practice.
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      if (!transcript) return;

      if (awaitingQuery) {
        clearTimeout(awaitingQueryTimeout);
        awaitingQuery = false;
        statusEl.textContent = "Heard you — thinking...";
        sendMessage(transcript);
        return;
      }

      const match = transcript.match(WAKE_PATTERN);
      if (match) {
        const query = transcript.slice(match[0].length).trim();
        if (query) {
          statusEl.textContent = "Heard you — thinking...";
          sendMessage(query);
        } else {
          armAwaitingQuery();
        }
      }
    };

    r.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "audio-capture" || event.error === "service-not-allowed") {
        heyFlowActive = false;
        updateHeyFlowUI();
        statusEl.textContent = "Mic access denied — Hey Flow turned off.";
      }
      // other errors (no-speech, network, aborted) just fall through to onend, which restarts
    };

    r.onend = () => {
      if (heyFlowActive && !ttsSpeaking) {
        try { r.start(); } catch (e) { /* already running */ }
      }
    };

    return r;
  }

  function startHeyFlowRecognizer() {
    heyFlowRecognizer = buildHeyFlowRecognizer();
    try {
      heyFlowRecognizer.start();
      statusEl.textContent = 'Listening for "Hey Flow"...';
    } catch (e) {
      console.error(e);
    }
  }

  function stopHeyFlow() {
    heyFlowActive = false;
    awaitingQuery = false;
    clearTimeout(awaitingQueryTimeout);
    updateHeyFlowUI();
    if (heyFlowRecognizer) {
      try { heyFlowRecognizer.stop(); } catch (e) { /* not running */ }
    }
    if (statusEl.textContent.startsWith("Listening for") || statusEl.textContent.startsWith("I'm listening")) {
      statusEl.textContent = "";
    }
  }

  function updateHeyFlowUI() {
    heyFlowBtn.textContent = heyFlowActive
      ? '🔴 "Hey Flow" is on — say it any time'
      : '🗣️ Enable "Hey Flow" hands-free';
    heyFlowBtn.classList.toggle("active", heyFlowActive);
  }

  heyFlowBtn.addEventListener("click", () => {
    if (heyFlowActive) {
      stopHeyFlow();
      return;
    }
    if (isRecording) stopRecordingAndTranscribe();
    heyFlowActive = true;
    updateHeyFlowUI();
    startHeyFlowRecognizer();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && heyFlowActive) {
      stopHeyFlow();
    }
  });
} else {
  heyFlowBtn.disabled = true;
  heyFlowBtn.title = "Not supported in this browser";
}
