# KidGuard backend

1. Create and activate a virtual environment.
2. Install dependencies: `pip install -r requirements.txt`
3. Copy `.env.example` to `.env` and set `OLLAMA_HOST` or `MODEL` if needed.
4. Ensure Ollama is serving the selected model, then run:

```bash
uvicorn backend.main:app --reload --port 8000
```

The Chrome extension can call `http://127.0.0.1:8000`. Open
`http://127.0.0.1:8000/docs` to inspect the local API. If Ollama is not running,
`/decide` and `/coach` return HTTP 503 with the configured host in the message.
