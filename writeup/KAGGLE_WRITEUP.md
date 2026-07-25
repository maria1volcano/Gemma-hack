# KidGuard — Kaggle Writeup Draft

**Title:** KidGuard: A Gemma 4 Agent That Protects Kids Online by Acting on the Page  
**Subtitle:** An autonomous Chrome buddy that explains risk, highlights safe next steps, and notifies parents — powered by Gemma 4 function calling  
**Track:** Autonomous Agents

---

## Problem

Children aged 8–11 increasingly browse alone. Blunt parental controls either block everything (frustrating) or miss clever phishing and pressure tactics. Kids need a **patient coach** that explains *why* something is risky and helps them choose a safer action — not a silent spy.

## Solution

**KidGuard** is a Chrome Manifest V3 extension plus a local FastAPI agent loop around **Gemma 4**. On each page load the extension scrapes URL, title, and visible text, sends them to Gemma, and executes the model’s **tool calls** on the live page:

- `warn_kid` — kid-friendly banner  
- `block_page` — interstitial with a safer alternative  
- `highlight_element` — pulsing ring on the dangerous or helpful control  
- `move_mascot` — 3D buddy mood / position  
- `notify_parent` — parent event feed  
- `suggest_alternative` / `navigate_hint` — coach side panel  

Gemma is essential: it chooses tools from page context, writes age-appropriate copy, and recovers with multiple tools in one turn. The extension is the actuator; Gemma is the decision-maker.

## Architecture

1. **Demo pages** on `localhost:8765` (school OK, clickbait, phishing, classroom)  
2. **Content script** scrapes the page and applies tools (highlight, overlays, mascot events)  
3. **Service worker** calls `POST /decide` or MOCK rules  
4. **FastAPI backend** runs an Ollama tool loop with Gemma 4 (`run_guard` / `run_coach`)  
5. **Parent dashboard** polls `GET /events`  

Privacy angle for the sprint: Gemma runs via local/tunneled Ollama (NVIDIA Brev GPU in our setup), not a third-party chat API as the core brain.

## How we use Gemma 4

- Native **function calling** with a frozen tool schema  
- System policy: guardian coach for age ~10; always decide via a tool  
- Truncated page text (~1500 chars) + recent event history  
- Max three tool rounds; every call is logged for the live demo  
- Coach mode for “help me open Classroom” with an allowlist  

## Engineering process (one-day sprint)

Parallel roles: backend/agent (A), extension core (B), 3D mascot (C), story/QA (N). We froze the tool contract early, verified it with `scripts/check_contract.sh`, and kept a MOCK path so UI could progress without GPU. Live mode points at Gemma 4 on an NVIDIA L4 via Brev port-forward.

## Challenges & choices

- **Shared HTTPS endpoints** for Ollama were auth-walled → SSH/`brev port-forward` to `localhost:11435`  
- **Auto-pause after two blocks** froze the extension mid-demo → disabled by default; resume resets risk counters  
- **Two mascot packages** (`extension/mascot` wired vs `mascot-ui` preview) → ship the wired Three.js capybara for the demo; treat React mascot-ui as next-step integration  
- Tool payload shape (`name`/`arguments` vs `tool`/`args`) → backend normalizes to the extension contract  

## Results

Contract suite passes against live Gemma. Golden path: allow school page → warn/block clickbait → **block phishing + parent notify + worried mascot** → coach suggests Classroom. Observable actions (not chat-only) satisfy the Autonomous Agents track.

## What’s next

Wire `mascot-ui` into the content script, add a real GLB asset, age profiles, and optional on-device Gemma for fully offline privacy.

---

*Word count target: keep under 1,500 when pasting to Kaggle. Trim “What’s next” if needed.*
