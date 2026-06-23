"""Thin wrapper around the OpenAI SDK pointed at OpenRouter.

OpenRouter is OpenAI-API-compatible, so we reuse the official `openai` client
and just swap the base URL. The key is pulled from config (env), never passed
around as a literal.
"""
from __future__ import annotations

from openai import OpenAI

from config import OPENROUTER_API_KEY, OPENROUTER_BASE_URL


def get_client() -> OpenAI:
    """Return an OpenAI client configured to talk to OpenRouter."""
    return OpenAI(
        base_url=OPENROUTER_BASE_URL,
        api_key=OPENROUTER_API_KEY,
    )


def chat(
    prompt: str,
    model: str = "anthropic/claude-sonnet-4-6",
    max_tokens: int = 512,
) -> str:
    """Send a single user prompt and return the assistant's text reply.

    `max_tokens` is capped low by default so requests stay within free-tier
    credits; raise it once the account has more credit.
    """
    client = get_client()
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
    )
    return resp.choices[0].message.content or ""
