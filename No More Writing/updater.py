"""
Auto-update check via GitHub Releases API.

Non-blocking: runs in a daemon thread on app start. If a newer release is
available, fires a callback so the UI can show an unobtrusive banner.

Comparison: integer-suffixed tags like "v1", "v2", "v3", with optional minor
("v1.1", "v1.2") so a hotfix can ship without bumping the big version.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

from version import VERSION, GITHUB_REPO

GITHUB_API = "https://api.github.com/repos/{repo}/releases/latest"
USER_AGENT = "no-more-writing-updater"


@dataclass
class UpdateInfo:
    latest: str
    current: str
    notes: str
    download_url: str | None
    html_url: str


_VER_RE = re.compile(r"^v(\d+)(?:\.(\d+))?$", re.IGNORECASE)


def parse(tag: str) -> tuple[int, int] | None:
    """Parse 'v1', 'v1.2', etc. Returns (major, minor) or None if unparseable."""
    m = _VER_RE.match(tag.strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2) or 0)


def is_newer(latest: str, current: str) -> bool:
    a = parse(latest)
    b = parse(current)
    if a is None or b is None:
        return False
    return a > b


def fetch_latest(repo: str = GITHUB_REPO, timeout: float = 6.0) -> UpdateInfo | None:
    """Synchronous fetch. Returns None on any failure (no network, repo missing, etc.)."""
    if not repo or "USER/" in repo:
        return None  # repo not configured yet
    url = GITHUB_API.format(repo=repo)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return None

    tag = data.get("tag_name", "")
    if not tag:
        return None

    # Find a Windows installer asset (.exe)
    download_url = None
    for asset in data.get("assets", []):
        name = asset.get("name", "").lower()
        if name.endswith(".exe") and "setup" in name:
            download_url = asset.get("browser_download_url")
            break

    return UpdateInfo(
        latest=tag,
        current=VERSION,
        notes=data.get("body", ""),
        download_url=download_url,
        html_url=data.get("html_url", ""),
    )


def check_async(
    on_update_available: Callable[[UpdateInfo], None],
    repo: str = GITHUB_REPO,
):
    """Fire-and-forget background check. Calls back only if a newer version exists."""
    def _worker():
        info = fetch_latest(repo)
        if info is None:
            return
        if is_newer(info.latest, info.current):
            try:
                on_update_available(info)
            except Exception:
                pass

    threading.Thread(target=_worker, daemon=True).start()
