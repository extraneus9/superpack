"""Sentinel — cloud intelligence layer (VirusTotal file-hash reputation).

Sends ONLY a file's SHA-256 (never the file, never user data) to VirusTotal and reads back
how many of ~70 engines call it malicious. This is the piece that gives a small engine the
whole industry's coverage.

Secret-safe & offline-safe by design:
  * The API key is read only from the environment variable VT_API_KEY. It is never written to
    disk, never logged, and never committed. Ship nothing but an empty VT_API_KEY.default.
  * With no key AND no cached verdict, the layer is simply inactive (returns "unknown").
  * A local JSON cache (hash -> verdict) lets the self-test run fully offline with no key and
    no network. Only hashes and verdict counts live in the cache — never secrets.
"""
from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

from .paths import DATA

HERE = Path(__file__).resolve().parent
DEFAULT_CACHE = DATA / "intel_cache.json"
VT_URL = "https://www.virustotal.com/api/v3/files/{}"

# TLS context backed by certifi's CA bundle, not the OS cert store. A frozen exe on a fresh
# machine (e.g. Windows Sandbox) has an incomplete system store, so OpenSSL can't verify VT's
# cert and every HTTPS lookup fails silently. certifi ships a known-good CA set with the app.
try:
    import certifi
    _SSL_CTX: ssl.SSLContext | None = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover - certifi optional; fall back to the default store
    _SSL_CTX = None


class VirusTotalIntel:
    def __init__(self, cache_path: str | os.PathLike | None = None, allow_network: bool = True):
        self.cache_path = Path(cache_path) if cache_path else DEFAULT_CACHE
        self.allow_network = allow_network
        self._api_key = os.environ.get("VT_API_KEY", "").strip().strip('"').strip("'").strip()
        if not self._api_key:   # end-user friendly: let people paste their own key into a file
            try:
                self._api_key = (DATA / "vt_key.txt").read_text(encoding="utf-8").strip().strip('"').strip("'").strip()
            except OSError:
                pass
        self.cache: dict[str, dict] = {}
        self._load_cache()
        # Pace live lookups for VirusTotal's free tier (4 req/min -> ~15s apart). Set
        # VT_MIN_INTERVAL=0 to disable (paid keys with higher limits).
        self._last_call = 0.0
        self._min_interval = float(os.environ.get("VT_MIN_INTERVAL", "15") or 0)

    @property
    def enabled(self) -> bool:
        """Active if we can answer at all — a key (for live lookups) or a non-empty cache."""
        return bool(self._api_key) or bool(self.cache)

    @property
    def online(self) -> bool:
        return bool(self._api_key) and self.allow_network

    # ---------- cache ----------
    def _load_cache(self) -> None:
        try:
            self.cache = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cache = {}

    def _save_cache(self) -> None:
        try:
            self.cache_path.write_text(json.dumps(self.cache, indent=2), encoding="utf-8")
        except OSError:
            pass

    def seed(self, sha256: str, malicious: int, total: int = 70) -> None:
        """Insert a verdict directly (used by the offline self-test)."""
        self.cache[sha256.lower()] = {"malicious": malicious, "total": total, "cached_at": time.time()}

    # ---------- lookup ----------
    def lookup_hash(self, sha256: str) -> dict:
        """Return {found, malicious, total, verdict}. Never raises; never blocks on network
        unless a key is configured and allow_network is True."""
        h = sha256.lower()
        if h in self.cache:
            c = self.cache[h]
            return self._verdict(True, c["malicious"], c.get("total", 70))
        if not self.online:
            return self._verdict(False, 0, 0)
        for attempt in range(2):          # pace for the free tier; retry once on rate-limit
            self._throttle()
            try:
                req = urllib.request.Request(VT_URL.format(h), headers={"x-apikey": self._api_key})
                with urllib.request.urlopen(req, timeout=12, context=_SSL_CTX) as r:
                    body = json.loads(r.read().decode("utf-8"))
                stats = body["data"]["attributes"]["last_analysis_stats"]
                mal = int(stats.get("malicious", 0)) + int(stats.get("suspicious", 0))
                total = sum(int(v) for v in stats.values())
                self.cache[h] = {"malicious": mal, "total": total, "cached_at": time.time()}
                self._save_cache()
                return self._verdict(True, mal, total)
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt == 0:          # rate-limited: wait, try once more
                    time.sleep(self._min_interval or 20)
                    continue
                return self._verdict(False, 0, 0)           # 404 = unknown to VT, 401 = bad key, etc.
            except (urllib.error.URLError, KeyError, ValueError, TimeoutError):
                return self._verdict(False, 0, 0)
        return self._verdict(False, 0, 0)

    def _throttle(self) -> None:
        """Space out live lookups so the free tier's 4/min cap doesn't start returning 429s."""
        if self._min_interval > 0:
            wait = self._min_interval - (time.time() - self._last_call)
            if wait > 0:
                time.sleep(wait)
        self._last_call = time.time()

    @staticmethod
    def _verdict(found: bool, malicious: int, total: int) -> dict:
        if not found:
            verdict = "UNKNOWN"
        elif malicious >= 5:
            verdict = "MALICIOUS"
        elif malicious >= 1:
            verdict = "SUSPICIOUS"
        else:
            verdict = "CLEAN"
        return {"found": found, "malicious": malicious, "total": total, "verdict": verdict}
