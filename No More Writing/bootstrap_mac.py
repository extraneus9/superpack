"""
First-launch bootstrap for the macOS build.

What this exists for: parity with Windows. On Windows the Inno Setup installer
runs a silent bootstrap that installs Ollama (via winget) and pulls the
gemma3:12b cleanup model. On macOS the .dmg only ships the .app, so the
equivalent setup has to happen the first time the app launches.

The user experience we're aiming for:
- App launches normally.
- If Ollama isn't installed, a modal "Setting up — first time only" dialog
  appears with a progress label and a Continue / Skip pair.
- "Continue" downloads the official Ollama app (Ollama-darwin.zip) into
  /Applications (or ~/Applications), no password needed, then starts the daemon
  and pulls the cleanup model. Each phase updates the dialog's status text.
- "Skip" closes the dialog. The app still works for raw dictation; the cleanup
  step is just disabled until the user runs setup later.

Idempotent: every check is "ask the OS what's actually there." Safe to re-run.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import time
from typing import Callable

IS_MAC = sys.platform == "darwin"

# Where the Ollama .app installer puts the binary, plus a couple of fallbacks
# for Homebrew layouts on Apple Silicon vs Intel.
_OLLAMA_PATH_CANDIDATES = [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/Applications/Ollama.app/Contents/Resources/ollama",
    os.path.expanduser("~/Applications/Ollama.app/Contents/Resources/ollama"),
]

# Default model for transcript cleanup. Mirrors config.default.json's `ollama_model` (the cleaner pulls that tag).
DEFAULT_MODEL = "gemma3:4b"

# The official macOS app (no admin password: it goes to ~/Applications when /Applications isn't writable)
OLLAMA_ZIP_URL = "https://ollama.com/download/Ollama-darwin.zip"
OLLAMA_API_URL = "http://localhost:11434/api/tags"


# ---------- Status callback type ----------

# Bootstrap is long-running; the caller passes a callback that updates UI text.
# Signature: (phase: str, detail: str | None) -> None
StatusCallback = Callable[[str, str], None]


def _noop(_phase: str, _detail: str = "") -> None:
    pass


# ---------- Probes ----------

def ollama_binary_path() -> str | None:
    """Return the path to the ollama binary or None if not found."""
    # `which` honors PATH; fall back to known install locations.
    found = shutil.which("ollama")
    if found:
        return found
    for p in _OLLAMA_PATH_CANDIDATES:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def is_ollama_installed() -> bool:
    return ollama_binary_path() is not None


def is_ollama_daemon_running(timeout: float = 1.5) -> bool:
    """Return True if the Ollama HTTP API answers at localhost:11434."""
    try:
        import urllib.request  # stdlib; cheaper than pulling in `requests`
        req = urllib.request.Request(OLLAMA_API_URL)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def is_model_pulled(model: str = DEFAULT_MODEL) -> bool:
    """Return True if `ollama list` shows the model name on its own line."""
    binary = ollama_binary_path()
    if not binary:
        return False
    try:
        out = subprocess.run(
            [binary, "list"],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        return False
    # `ollama list` prints columns; first column is NAME[:TAG]. The exact tag must be there (gemma3:12b ≠ gemma3:4b).
    want = model if ":" in model else model + ":latest"
    for line in out.splitlines()[1:]:
        name = (line.split() or [""])[0]
        if name == want:
            return True
    return False


def setup_needed() -> tuple[bool, str]:
    """Return (needs_setup, reason). Used by the UI to decide whether to show
    the bootstrap dialog at all."""
    if not is_ollama_installed():
        return True, "Ollama is not installed yet."
    if not is_ollama_daemon_running():
        return True, "Ollama is installed but not running."
    if not is_model_pulled():
        return True, f"The cleanup model ({DEFAULT_MODEL}) hasn't been downloaded yet."
    return False, ""


# ---------- Install actions ----------

def install_ollama_with_admin(on_status: StatusCallback = _noop) -> None:
    """Install the official Ollama app: download Ollama-darwin.zip and unpack it into /Applications (or
    ~/Applications when /Applications isn't writable). No password, no Terminal. (The name is kept for callers;
    the old install.sh route was Linux-only.)

    Raises RuntimeError if the download fails or `ollama` still isn't there afterwards.
    """
    import tempfile
    import urllib.request

    on_status("Installing Ollama", "downloading (about 200 MB)...")
    dest = "/Applications" if os.access("/Applications", os.W_OK) else os.path.expanduser("~/Applications")
    os.makedirs(dest, exist_ok=True)
    zip_path = os.path.join(tempfile.gettempdir(), "Ollama-darwin.zip")
    try:
        urllib.request.urlretrieve(OLLAMA_ZIP_URL, zip_path)
    except Exception as e:
        raise RuntimeError(f"Ollama download failed: {e}")
    on_status("Installing Ollama", "unpacking...")
    proc = subprocess.run(["/usr/bin/ditto", "-x", "-k", zip_path, dest], capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"Ollama unpack failed: {(proc.stderr or '').strip() or 'unknown error'}")
    # it was downloaded by this app on purpose: no "downloaded from the internet" prompt on first open
    subprocess.run(["/usr/bin/xattr", "-dr", "com.apple.quarantine", os.path.join(dest, "Ollama.app")], capture_output=True)

    if not is_ollama_installed():
        raise RuntimeError("Ollama was unpacked but its `ollama` binary isn't there. Install it from ollama.com.")

    on_status("Installing Ollama", "done.")


def ensure_daemon_running(on_status: StatusCallback = _noop, timeout: float = 15.0) -> None:
    """Make sure `ollama serve` is up. Spawns it in the background if needed
    and polls the API until it answers or we hit `timeout` seconds."""
    if is_ollama_daemon_running():
        return

    binary = ollama_binary_path()
    if not binary:
        raise RuntimeError("ollama binary not found; can't start the daemon.")

    on_status("Starting Ollama", "background daemon...")

    # Spawn `ollama serve` fully detached so it survives our app exiting.
    # nohup + redirect to /tmp/ollama.log is enough; we don't need a launchd plist.
    log = open("/tmp/ollama.log", "a")
    subprocess.Popen(
        [binary, "serve"],
        stdin=subprocess.DEVNULL,
        stdout=log, stderr=log,
        start_new_session=True,
    )

    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_ollama_daemon_running():
            on_status("Starting Ollama", "ready.")
            return
        time.sleep(0.5)
    raise RuntimeError(f"Ollama daemon didn't come up within {timeout}s — check /tmp/ollama.log")


def pull_model(model: str = DEFAULT_MODEL, on_status: StatusCallback = _noop) -> None:
    """Pull a model via `ollama pull`. Streams the CLI's progress output and
    forwards each line to `on_status` so the dialog can show what's happening."""
    if is_model_pulled(model):
        on_status(f"Downloading {model}", "already present.")
        return

    binary = ollama_binary_path()
    if not binary:
        raise RuntimeError("ollama binary not found; can't pull a model.")

    on_status(f"Downloading {model}", "this is the ~8 GB step.")

    # Stream stdout line by line so we can forward each progress update.
    proc = subprocess.Popen(
        [binary, "pull", model],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    assert proc.stdout is not None
    last = ""
    for raw in proc.stdout:
        line = raw.strip()
        # Ollama emits VT100 backspaces for the progress bar; we only forward
        # lines that look like state changes ("pulling X...", "verifying...",
        # "success"). Suppresses spammy ASCII-bar updates.
        if not line:
            continue
        if line == last:
            continue
        if any(k in line.lower() for k in ("pulling", "verifying", "writing", "success")):
            on_status(f"Downloading {model}", line)
            last = line
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"`ollama pull {model}` failed with exit code {proc.returncode}")
    on_status(f"Downloading {model}", "done.")


# ---------- Orchestrator ----------

def run_full_setup(on_status: StatusCallback = _noop, model: str = DEFAULT_MODEL) -> None:
    """Do every step needed to bring a fresh Mac up to a working app:
    install Ollama (if missing) → start daemon → pull cleanup model.

    Raises on any failure so the caller can show an error in the dialog and
    let the user retry or skip."""
    if not IS_MAC:
        return  # bootstrap_mac is a Mac-only module; no-op elsewhere

    if not is_ollama_installed():
        install_ollama_with_admin(on_status)
    else:
        on_status("Installing Ollama", "already installed.")

    ensure_daemon_running(on_status)
    pull_model(model, on_status)

    on_status("Setup complete", "everything's ready.")


if __name__ == "__main__":
    # Smoke test: run from CLI to validate the install pipeline outside the GUI.
    def print_status(phase: str, detail: str = "") -> None:
        print(f"[{phase}] {detail}")

    needs, reason = setup_needed()
    if not needs:
        print("Nothing to do — bootstrap state is clean.")
        sys.exit(0)
    print(f"Setup needed: {reason}")
    run_full_setup(print_status)
