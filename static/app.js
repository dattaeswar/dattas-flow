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

// --- Speech-to-text ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
let heyFlowActive = false;
let heyFlowRecognizer = null;

if (SpeechRecognition) {
  // Single-shot "tap to talk" recognizer
  recognizer = new SpeechRecognition();
  recognizer.lang = "en-US";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  recognizer.onstart = () => {
    listening = true;
    micBtn.classList.add("listening");
    statusEl.textContent = "Listening...";
  };

  recognizer.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    sendMessage(transcript);
  };

  recognizer.onerror = (event) => {
    statusEl.textContent = `Mic error: ${event.error}`;
  };

  recognizer.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    if (statusEl.textContent === "Listening...") statusEl.textContent = "";
  };

  const toggleMic = () => {
    if (heyFlowActive) stopHeyFlow();
    if (listening) {
      recognizer.stop();
    } else {
      recognizer.start();
    }
  };

  micBtn.addEventListener("click", toggleMic);

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      toggleMic();
    }
  });

  // --- "Hey Flow" hands-free wake phrase (continuous listening) ---
  // Real background wake-word detection (like "Hey Siri") needs a native app;
  // a web page can only listen while it's open, in the foreground, and the
  // screen is on. This is the closest practical equivalent for a web app.
  const WAKE_PATTERN = /^(hey|hi|hi there|ok|okay)[,.\s]+flow\b[,:.\s]*/i;

  function buildHeyFlowRecognizer() {
    const r = new SpeechRecognition();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const transcript = result[0].transcript.trim();
        const match = transcript.match(WAKE_PATTERN);
        if (match) {
          const query = transcript.slice(match[0].length).trim();
          if (query) {
            statusEl.textContent = "Heard you — thinking...";
            sendMessage(query);
          } else {
            statusEl.textContent = "I'm listening, go ahead...";
          }
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
    updateHeyFlowUI();
    if (heyFlowRecognizer) {
      try { heyFlowRecognizer.stop(); } catch (e) { /* not running */ }
    }
    if (statusEl.textContent.startsWith("Listening for")) statusEl.textContent = "";
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
    if (listening) recognizer.stop();
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
  micBtn.disabled = true;
  micBtn.title = "Speech recognition not supported in this browser (try Chrome)";
  heyFlowBtn.disabled = true;
  heyFlowBtn.title = "Speech recognition not supported in this browser";
}
