"""Optional photo-realistic try-on engine (diffusion model).

The live mirror does not need this. An installer will place the model in ./ai;
until then installed() returns False and the mirror hides the AI button.
"""
from pathlib import Path

AI_DIR = Path(__file__).resolve().parent / "ai"


def installed() -> bool:
    return (AI_DIR / "READY").exists()


def load():
    if not installed():
        raise RuntimeError("AI try-on is not set up yet (see README)")
    import sys
    sys.path.insert(0, str(AI_DIR))
    from ai_engine import Engine  # provided by the AI installer
    return Engine(AI_DIR)
