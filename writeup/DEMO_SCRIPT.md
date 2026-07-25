# KidGuard — Demo Script (2–3 minutes)

## Before you press record

1. Brev instance **Running**
2. Mac terminals:
   ```bash
   brev port-forward bs7vrlon8 -p 11435:11434
   # other terminal:
   cd "/Users/youssef/Python Projects/Gemma-hack"
   source .venv/bin/activate
   uvicorn backend.main:app --host 127.0.0.1 --port 8000
   python3 -m http.server 8765 --bind 127.0.0.1
   ```
3. Chrome → `chrome://extensions` → **Reload** KidGuard  
4. Side panel: **LIVE** (not MOCK), click **Parent: resume session**  
5. Windows open: demo tab + parent feed tab

## Spoken path

**0:00 — Problem (15s)**  
“Kids get stuck or tricked online. Filters just say no. KidGuard is a Gemma 4 agent that explains and *acts* on the page.”

**0:15 — Safe page (20s)**  
Open http://127.0.0.1:8765/demo_sites/ok_school.html  
“Gemma allows the page, the mascot stays calm, maybe highlights something helpful.”

**0:35 — Clickbait (25s)**  
Open http://127.0.0.1:8765/demo_sites/clickbait.html  
“Here Gemma warns in kid language instead of silently blocking everything.”

**1:00 — Phishing hero (45s)**  
Open http://127.0.0.1:8765/demo_sites/phishing.html  
Show block overlay + worried mascot.  
Flip to http://127.0.0.1:8765/frontend/parent.html  
“Parents see a clear event — not a raw surveillance dump.”

**1:45 — Coach (30s)**  
Side panel: “Help me open Classroom.”  
“Gemma uses tools to suggest a safe next step.”

**2:15 — Close (20s)**  
“Gemma 4 is the brain — function calling turns judgment into observable actions. KidGuard coaches kids; it doesn’t just spy.”

## If something freezes

- Side panel → **Parent: resume session**  
- Confirm badge says **LIVE**  
- Reload the extension, then hard-refresh the demo page  
- Check `curl http://127.0.0.1:11435/api/tags` and `curl http://127.0.0.1:8000/state`
