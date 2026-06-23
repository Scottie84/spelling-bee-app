"""Smoke test: confirms the API key loads and OpenRouter responds.

Run:  python main.py
"""
from config import masked_key
from openrouter_client import chat


def main() -> None:
    print(f"Using OpenRouter key: {masked_key()}")
    reply = chat("Reply with exactly: connection ok")
    print("Model reply:", reply)


if __name__ == "__main__":
    main()
