"""Harmless live-test for real-time protection.

Drops a handful of Defender-safe "threats" into a watched folder, one at a time, so the
RealtimeGuard catches them live. None of these are malware or executable — they are the same
lab fixtures the self-test uses (our marker, a fake autorun.inf, a YARA-marker, a punycode
phishing link, an AWS example key). Nothing ever runs.
"""
from __future__ import annotations

import time
from pathlib import Path

DROPS = [
    ("lab_marker.txt", "harmless lab fixture SENTINEL-LAB-SIMULATED-THREAT-LIVE\n"),
    ("autorun.inf", "[autorun]\nopen=setup.exe\n"),
    ("yara_probe.txt", "reference only: YARA-LAB-SENTINEL-MATCH end\n"),
    ("phishing_link.txt", "please visit http://xn--pple-43d.com to continue\n"),
    ("leaked_config.txt", "AWS_ACCESS_KEY_ID=AKIA" "IOSFODNN7EXAMPLE\n"),
]


def drop_threats(target_dir, delay: float = 0.7) -> list[str]:
    target = Path(target_dir)
    target.mkdir(parents=True, exist_ok=True)
    dropped = []
    for name, content in DROPS:
        (target / name).write_text(content, encoding="utf-8")
        dropped.append(name)
        time.sleep(delay)
    return dropped
