"""FastAPI entry point for the KidGuard local backend."""

from __future__ import annotations

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.agent import (
    OllamaResponseError,
    OllamaUnavailableError,
    run_coach,
    run_guard,
)
from backend.store import GuardStore

load_dotenv()

app = FastAPI(title="KidGuard API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
store = GuardStore()


class DecideRequest(BaseModel):
    url: str
    title: str = ""
    text: str = ""
    age: int | None = Field(default=None, ge=1, le=18)


class CoachRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


def _agent_error(error: Exception) -> HTTPException:
    if isinstance(error, OllamaUnavailableError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=502, detail=str(error))


@app.post("/decide")
async def decide(request: DecideRequest) -> dict:
    try:
        result = await run_guard(
            url=request.url,
            title=request.title,
            text=request.text,
            age=request.age,
            store=store,
        )
    except (OllamaUnavailableError, OllamaResponseError) as exc:
        raise _agent_error(exc) from exc

    state = store.state()
    return {
        "action": result["action"],
        "kid_message": state["last_kid_message"],
        "tool_calls": result["tool_calls"],
        "events": store.events(),
    }


@app.post("/coach")
async def coach(request: CoachRequest) -> dict:
    try:
        result = await run_coach(message=request.message, store=store)
    except (OllamaUnavailableError, OllamaResponseError) as exc:
        raise _agent_error(exc) from exc

    return {
        "action": result["action"],
        "kid_message": store.state()["last_kid_message"],
        "tool_calls": result["tool_calls"],
    }


@app.get("/events")
async def events() -> list[dict]:
    return store.events()


@app.get("/state")
async def state() -> dict:
    return store.state()


@app.post("/resume")
async def resume() -> dict:
    return store.resume()
