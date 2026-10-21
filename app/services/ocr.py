"""Offline OCR subprocess. Never log recognized text or stderr."""
import os
import shutil
import subprocess
from pathlib import Path
from time import perf_counter

TIMEOUT_SECONDS = 15


def recognize(path: Path) -> dict:
    start = perf_counter()
    result = {"status": "failed", "text": "", "error": None}
    try:
        binary = os.environ.get("TESSERACT_CMD") or shutil.which("tesseract")
        if not binary:
            raise FileNotFoundError
        process = subprocess.run(
            [binary, path.name, "stdout", "-l", "eng+chi_sim", "--psm", "6"],
            cwd=path.resolve().parent, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=TIMEOUT_SECONDS, check=False, env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        )
        if process.returncode:
            result["error"] = "recognition_failed"
        else:
            result["text"] = process.stdout.strip()[:50000]
            result["status"] = "completed" if result["text"] else "no_text"
    except subprocess.TimeoutExpired:
        result["error"] = "timeout"
    except (OSError, UnicodeError):
        result["error"] = "ocr_unavailable"
    result["duration_ms"] = round((perf_counter() - start) * 1000)
    return result
