const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const micBtn = document.getElementById("mic-btn");
const statusEl = document.getElementById("status");
const voiceToggle = document.getElementById("voice-toggle");
const modeButtons = document.querySelectorAll(".mode-btn");
const modeDescEl = document.getElementById("mode-desc");

const MODE_DESCRIPTIONS = {
  friend: "Short, casual replies — like talking to a friend.",
  standard: "Full, structured answers — like a normal AI assistant.",
};

let history = [];
let voiceOn = true;
let mode = "friend";

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

function speak(text) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
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

// --- Speech-to-text (mic input) ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;

if (SpeechRecognition) {
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
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition not supported in this browser (try Chrome)";
}
