# Datta's Flow

A voice-and-text AI assistant that talks back like a friend, not a corporate bot. Built on NVIDIA NIM (`openai/gpt-oss-120b`), with browser-based speech-to-text and text-to-speech, live web-search grounding, and a toggle between casual "friend chat" and full "standard AI" answers.

## Features

- Mic input (`Ctrl+Shift+Space` or the mic button) and spoken replies, via the browser's built-in speech APIs
- Two response modes: short/casual "Friend chat" vs. detailed/structured "Standard AI"
- Optional live web search (Tavily) for up-to-date answers
- Per-IP rate limiting, input validation, and prompt-injection resistance on the backend

## Local setup

```bash
python -m venv .venv
.venv/Scripts/activate   # or source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env     # then fill in your NVIDIA_API_KEY
uvicorn server:app --reload
```

Visit `http://localhost:8000`.

## Deploying to Vercel

```bash
vercel
vercel env add NVIDIA_API_KEY production
vercel --prod
```

The frontend (`static/`) is served as static assets; `/api/*` routes to the FastAPI app in `api/index.py` (shared logic lives in `app_core.py`).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NVIDIA_API_KEY` | yes | API key from [build.nvidia.com](https://build.nvidia.com) |
| `NIM_MODEL` | no | Defaults to `openai/gpt-oss-120b` |
| `TAVILY_API_KEY` | no | Enables live web search grounding |
