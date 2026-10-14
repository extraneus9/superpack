"""
whisper-flow engine — audio capture, transcription, cleanup, paste.

Exposes a Flow class with state callbacks so any UI (CLI, GUI, tray) can drive it.
"""

from __future__ import annotations

import collections
import json
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from platform_hooks import IS_MAC, IS_WIN, beep as _platform_beep, prerender_beeps, send_paste_shortcut

# CUDA DLL bootstrap MUST come before faster_whisper / ctranslate2 are imported.
# On Mac this is a no-op (the function exits early if it can't find nvidia/).
from cuda_bootstrap import bootstrap as _cuda_bootstrap
_cuda_bootstrap()

import numpy as np
import pyperclip
import sounddevice as sd

from structure import (
    apply_structure, apply_voice_commands, needs_llm_for_structure, punctuate_markers,
)

from paths import ROOT, USER_DIR, ensure_user_config
# source: config.json next to the code (unchanged) · installed: %APPDATA%\NoMoreWriting, seeded clean
CONFIG_PATH = ensure_user_config()


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


CFG = load_config()


def reload_config():
    """Reload config from disk into the global CFG dict (in place)."""
    new = load_config()
    CFG.clear()
    CFG.update(new)


def save_config():
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(CFG, f, indent=2, ensure_ascii=False)


# ---------- Input-device enumeration & selection ----------

# On Windows the same physical mic is exposed under several host APIs (MME,
# DirectSound, WASAPI, WDM-KS). We collapse those to ONE entry per device,
# preferring the modern low-latency API. Best-first.
_HOSTAPI_PREFERENCE = [
    "Windows WASAPI", "MME", "Windows DirectSound", "Windows WDM-KS",
    "Core Audio", "ALSA", "PulseAudio", "JACK Audio Connection Kit",
]


def _is_alias_device(name: str) -> bool:
    """Host-API router / placeholder pseudo-devices, not real mics."""
    n = (name or "").strip().lower()
    return (not n) or n == "input ()" or "sound mapper" in n or "primary sound capture" in n


def is_narrowband_mic(name: str, native_rate: float) -> bool:
    """A Bluetooth 'Hands-Free' (HFP) endpoint — telephone-quality audio, 8 kHz, and quiet.
    Windows only gives a wireless mic that profile when it is paired as a headset; the same
    hardware on its USB receiver is 48 kHz and far cleaner."""
    n = (name or "").lower()
    return 0 < native_rate <= 8000 or "hands-free" in n or "bthhfenum" in n


def list_input_devices() -> list[dict]:
    """De-duplicated list of real input devices, best host API per physical mic.

    Each entry: {index, name, hostapi, is_default}. Sorted by name. Used to
    populate the microphone picker in settings."""
    try:
        devices = sd.query_devices()
        hostapis = sd.query_hostapis()
    except Exception:
        return []
    try:
        default_in = sd.default.device[0]
        default_name = devices[default_in]["name"].strip() if default_in is not None and default_in >= 0 else ""
    except Exception:
        default_name = ""

    pref = {name: i for i, name in enumerate(_HOSTAPI_PREFERENCE)}
    best: dict[str, dict] = {}
    for idx, d in enumerate(devices):
        if d.get("max_input_channels", 0) <= 0:
            continue
        name = (d.get("name") or "").strip()
        if _is_alias_device(name):
            continue
        ha = d.get("hostapi", -1)
        hostapi_name = hostapis[ha]["name"] if 0 <= ha < len(hostapis) else "?"
        rank = pref.get(hostapi_name, 99)
        prev = best.get(name)
        if prev is None or rank < prev["_rank"]:
            rate = int(d.get("default_samplerate", 0) or 0)
            best[name] = {
                "index": idx,
                "name": name,
                "hostapi": hostapi_name,
                "is_default": (name == default_name),
                "native_rate": rate,
                "narrowband": is_narrowband_mic(name, rate),
                "_rank": rank,
            }
    out = sorted(best.values(), key=lambda e: e["name"].lower())
    for e in out:
        e.pop("_rank", None)
    return out


def _system_default_input_ok() -> bool:
    """True if PortAudio has a usable default input device.

    On Windows, if the user has no 'Default Device' set for recording (or the
    default mic was removed), sd.default.device[0] is -1 and opening device=None
    raises 'Error querying device -1'. Detect that so we can fall back to a real
    device instead of hard-failing every dictation."""
    try:
        di = sd.default.device[0]
    except Exception:
        return False
    if di is None or di < 0:
        return False
    try:
        return sd.query_devices(di).get("max_input_channels", 0) > 0
    except Exception:
        return False


def _first_real_input_index() -> int | None:
    """Index of the best available real input device, or None if there are none.

    Last-resort mic when the OS has no valid default and the user hasn't picked
    one — keeps recording working out of the box on a fresh/misconfigured box."""
    devs = list_input_devices()
    return devs[0]["index"] if devs else None


def resolve_input_device() -> int | None:
    """Config → a valid sounddevice input index, or None for the system default.

    Validates the stored index still points at the stored device name; if the
    device was unplugged/re-indexed, recovers by name. When the user wants the
    system default but the OS has no valid default input, falls back to the first
    real input device so recording never hard-fails."""
    idx = CFG.get("input_device")
    want_name = (CFG.get("input_device_name") or "").strip()
    if idx is None and not want_name:
        # User wants the system default. Only trust it if it's actually usable;
        # otherwise pin to a real device (fixes 'Error querying device -1').
        return None if _system_default_input_ok() else _first_real_input_index()
    try:
        devices = sd.query_devices()
    except Exception:
        return None if _system_default_input_ok() else _first_real_input_index()
    # Trust the stored index only if it still names the same device.
    if isinstance(idx, int) and 0 <= idx < len(devices):
        d = devices[idx]
        if d.get("max_input_channels", 0) > 0 and (not want_name or (d.get("name") or "").strip() == want_name):
            return idx
    # Recover by name across a re-indexed device list.
    if want_name:
        for i, d in enumerate(devices):
            if d.get("max_input_channels", 0) > 0 and (d.get("name") or "").strip() == want_name:
                return i
    # Nothing matched — prefer a real device over the (possibly invalid) default.
    return None if _system_default_input_ok() else _first_real_input_index()


def measure_input_clip(device: int | None, seconds: float = 1.2, sample_rate: int = 16000) -> np.ndarray:
    """Capture a short mono clip from `device` (float32, [-1, 1]).

    Used by the settings 'Test' button to confirm the chosen mic is live and to show
    how loud it really is. Retries at the device's native samplerate if 16 kHz isn't
    supported. Raises on a busy/invalid device so the UI can report it."""
    try:
        data = sd.rec(int(seconds * sample_rate), samplerate=sample_rate,
                      channels=1, dtype="float32", device=device)
        sd.wait()
    except Exception:
        info = sd.query_devices(device) if device is not None else sd.query_devices(kind="input")
        sr = int(info.get("default_samplerate", 44100))
        data = sd.rec(int(seconds * sr), samplerate=sr, channels=1, dtype="float32", device=device)
        sd.wait()
    return data.flatten()


def measure_input_level(device: int | None, seconds: float = 1.2, sample_rate: int = 16000) -> float:
    """Peak amplitude in [0, 1] of a short capture from `device` (see measure_input_clip)."""
    data = measure_input_clip(device, seconds, sample_rate)
    return float(np.max(np.abs(data))) if data.size else 0.0


# ---------- Input level conditioning ----------
#
# "I have to shout for it to hear me": a quiet mic (a DJI receiver's line-level USB output, a
# Bluetooth headset, a low Windows input level) hands the transcriber audio so faint that
# faster-whisper's VAD stage drops the speech before Whisper ever sees it, and Whisper itself
# is trained on normally-recorded levels. condition_audio() brings a recording to a healthy
# level BEFORE VAD + Whisper:
#   1. Input boost — a fixed gain from Settings (x1 .. x10), for people who want the overlay
#      waveform and the mic test to read hotter too.
#   2. Auto level — raises a quiet recording so its loud passages land near -6 dBFS. It never
#      lowers a recording, never touches near-silence, and is capped at +34 dB.

BOOST_RANGE = (1.0, 10.0)
AUTO_LEVEL_TARGET = 0.5        # loud passages (99.5th percentile) end up at ~ -6 dBFS
AUTO_LEVEL_MAX_GAIN = 50.0     # +34 dB ceiling
AUTO_LEVEL_MIN_GAIN = 2.0      # a recording whose loud parts already sit above ~ -12 dBFS is left byte-identical
AUTO_LEVEL_FLOOR = 0.001       # -60 dBFS: below this it's digital silence, nothing to rescue
AUTO_LEVEL_BIG_GAIN = 8.0      # above +18 dB we first make sure it looks like speech, not hiss
AUTO_LEVEL_MIN_CREST = 5.0     # speech peaks stand well above its median; steady noise doesn't
CLIP_CEILING = 0.98            # never push more than 0.1 % of samples past this


def input_boost() -> float:
    """The configured manual boost, clamped to BOOST_RANGE."""
    try:
        b = float(CFG.get("input_boost", 1.0))
    except (TypeError, ValueError):
        return 1.0
    if b != b:  # NaN
        return 1.0
    return max(BOOST_RANGE[0], min(BOOST_RANGE[1], b))


def condition_audio(audio: np.ndarray | None, boost: float | None = None,
                    auto_level: bool | None = None) -> tuple[np.ndarray | None, float]:
    """Return (audio, gain): the recording brought to a healthy level and the total gain applied.

    `boost` / `auto_level` default to the saved settings; Settings passes its draft values to
    preview them. Never raises, and hands the input back untouched (gain 1.0) whenever there
    is nothing safe to do."""
    if audio is None or audio.size == 0:
        return audio, 1.0
    try:
        boost = input_boost() if boost is None else max(BOOST_RANGE[0], min(BOOST_RANGE[1], float(boost)))
        auto = bool(CFG.get("auto_level", True)) if auto_level is None else bool(auto_level)
        x = audio.astype(np.float32, copy=False)
        mag = np.abs(x)
        gain = boost
        peak = 0.0
        if auto:
            peak = float(np.percentile(mag, 99.5))
            if peak >= AUTO_LEVEL_FLOOR:
                want = min(AUTO_LEVEL_MAX_GAIN, AUTO_LEVEL_TARGET / peak)
                if want > AUTO_LEVEL_BIG_GAIN:
                    # A huge gain on a recording that is just steady noise would manufacture
                    # "speech" for Whisper to hallucinate on. Real speech has loud peaks
                    # well above its median level; hiss and hum do not.
                    median = float(np.percentile(mag, 50))
                    if median > 0 and peak / median < AUTO_LEVEL_MIN_CREST:
                        want = 1.0
                # the manual boost already counts toward the target
                gain = max(boost, want) if want > AUTO_LEVEL_MIN_GAIN else boost
        if gain <= 1.0 + 1e-6:
            return audio, 1.0
        # Headroom: however much gain was asked for, don't clip more than ~0.1 % of samples.
        top = float(np.percentile(mag, 99.9))
        if top > 0:
            gain = min(gain, CLIP_CEILING / top)
        if gain <= 1.0 + 1e-6:
            return audio, 1.0
        return np.clip(x * gain, -1.0, 1.0).astype(np.float32, copy=False), gain
    except Exception:
        return audio, 1.0


# ---------- State ----------

class State:
    IDLE = "idle"
    RECORDING = "recording"
    PROCESSING = "processing"


@dataclass
class TranscriptEntry:
    timestamp: float
    raw: str
    cleaned: str
    whisper_ms: int
    ollama_ms: int
    total_ms: int
    pasted: bool = True
    peak_db: float | None = None   # loudest moment of the raw recording, dBFS — shows up a quiet mic
    gain_db: float = 0.0           # boost + auto level applied before transcribing


# ---------- Audio capture ----------

class Recorder:
    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate       # target rate the transcriber expects (16 kHz)
        self._capture_rate = sample_rate     # actual open rate; may differ if the device rejects 16 kHz
        self.frames: list[np.ndarray] = []
        self.stream: sd.InputStream | None = None
        self.recording = False
        self._lock = threading.Lock()
        self.last_status = ""  # most recent PortAudio status flag, for diagnostics
        self.active_device = ""  # human label of the device actually opened, for diagnostics
        # Rolling level history for live waveform display. Values in [0, 1].
        self.levels: collections.deque[float] = collections.deque([0.0] * 32, maxlen=32)
        self._boost = 1.0  # manual input boost, sampled at start() so the meter matches what's transcribed

    def _open_stream(self, device: int | None, rate: int) -> "sd.InputStream":
        return sd.InputStream(
            samplerate=rate,
            device=device,
            channels=1,
            dtype="float32",
            blocksize=0,
            latency="high",
            callback=self._callback,
        )

    def _callback(self, indata, frames, time_info, status):
        # CRITICAL: this runs on PortAudio's realtime thread. If ANY exception
        # escapes, PortAudio aborts the stream and recording silently dies
        # mid-sentence. In the packaged (console=False) build sys.stderr is None,
        # so the old `print(..., file=sys.stderr)` crashed on the first input
        # overflow — which is exactly what happens during long dictations. Never
        # let anything raise out of here; just record the flag for later.
        try:
            if status:
                self.last_status = str(status)
            with self._lock:
                if self.recording:
                    self.frames.append(indata.copy())
                    # compute RMS, normalize to ~speech range. Typical speech RMS 0.02-0.2.
                    # The manual input boost is included so a quiet mic still drives the
                    # overlay waveform (auto level is applied after the fact, on the whole clip).
                    rms = float(np.sqrt(np.mean(np.square(indata.astype(np.float32)))))
                    self.levels.append(min(1.0, rms * 6.0 * self._boost))
        except Exception:
            # Swallow everything — a dropped block is recoverable, an aborted
            # stream is not. Worst case we lose one ~10ms block of audio.
            pass

    def start(self):
        if self.recording:
            return
        self.frames = []
        self.recording = True
        self.last_status = ""
        self._capture_rate = self.sample_rate
        self._boost = input_boost()

        # Which mic to open: the user's picked device (validated fresh each time,
        # so a change in settings applies to the very next dictation), else the
        # system default.
        device = resolve_input_device()

        # Open with graceful degradation so device selection can never hard-fail
        # a dictation. latency="high" uses larger internal buffers, making input
        # overflows (the old mid-recording crash trigger) far less likely.
        # blocksize=0 lets PortAudio pick an efficient block size.
        #   1) picked device @ 16 kHz
        #   2) picked device @ its native rate (resampled on stop) — some mics
        #      only expose 44.1/48 kHz
        #   3) system default @ 16 kHz — last-resort so we still record something
        attempts: list[tuple[int | None, int]] = [(device, self.sample_rate)]

        def _add_native_rate(dev: int) -> None:
            try:
                native = int(sd.query_devices(dev).get("default_samplerate", 0)) or 48000
            except Exception:
                native = 48000
            if native != self.sample_rate:
                attempts.append((dev, native))

        if device is not None:
            _add_native_rate(device)
            attempts.append((None, self.sample_rate))
        else:
            # Picked device is the system default (None). If that default is
            # invalid (no Windows recording default set → device -1), opening
            # None hard-fails, so append a real device as the fallback.
            real = _first_real_input_index()
            if real is not None:
                attempts.append((real, self.sample_rate))
                _add_native_rate(real)

        last_err: Exception | None = None
        for dev, rate in attempts:
            try:
                self.stream = self._open_stream(dev, rate)
                self.stream.start()
                self._capture_rate = rate
                try:
                    self.active_device = sd.query_devices(dev)["name"] if dev is not None else "system default"
                except Exception:
                    self.active_device = "system default" if dev is None else str(dev)
                if rate != self.sample_rate:
                    self.last_status = f"opened @ {rate} Hz (resampling to {self.sample_rate})"
                return
            except Exception as e:
                last_err = e
                self.stream = None
                continue

        # Nothing opened — surface it and leave recording flagged off.
        self.recording = False
        self.last_status = f"open failed: {last_err}"
        raise last_err if last_err else RuntimeError("no audio input device available")

    def stop(self) -> np.ndarray | None:
        if not self.recording:
            return None
        with self._lock:
            self.recording = False
        if self.stream:
            # Guard against the stream already being in an aborted/error state —
            # we still want the frames captured up to that point, so never let a
            # teardown error throw away the audio.
            try:
                self.stream.stop()
                self.stream.close()
            except Exception as e:
                self.last_status = f"teardown: {e}"
            self.stream = None
        # reset level meter
        for _ in range(len(self.levels)):
            self.levels.append(0.0)
        if not self.frames:
            return None
        audio = np.concatenate(self.frames, axis=0).flatten()
        self.frames = []
        # If the device forced a non-16 kHz open, resample to the rate the
        # transcriber expects. Linear interpolation is plenty for speech and
        # avoids pulling in scipy.
        if self._capture_rate and self._capture_rate != self.sample_rate and audio.size:
            n_out = int(round(len(audio) * self.sample_rate / self._capture_rate))
            if n_out > 0:
                x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
                x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
                audio = np.interp(x_new, x_old, audio).astype(np.float32)
        return audio

    def discard(self):
        """Stop recording and drop everything, used for cancel."""
        if self.recording:
            self.stop()
        self.frames = []


# ---------- Transcription ----------

# Bilingual hint shown to Whisper as initial_prompt when the user has 2+ languages
# configured. Mixing both languages in the hint signals that code-switching is allowed
# within a single utterance, e.g. "esto es what's going to happen".
_BILINGUAL_HINTS = {
    frozenset(["es", "en"]): "Hola, how are you. Sí, ok. Esto es what's going to happen. Gracias, thank you.",
    frozenset(["es", "pt"]): "Hola, olá. Sí, sim. Gracias, obrigado.",
    frozenset(["fr", "en"]): "Bonjour, hello. Oui, yes. Merci, thank you.",
}


def _build_initial_prompt() -> str | None:
    langs = CFG.get("languages") or []
    forced = CFG.get("language") or (langs[0] if len(langs) == 1 else None)
    vocab = CFG.get("vocabulary") or []
    parts: list[str] = []
    if vocab:
        parts.append(", ".join(vocab))
    if forced is None and len(langs) >= 2:
        hint = _BILINGUAL_HINTS.get(frozenset(langs))
        if hint:
            parts.append(hint)
    return " ".join(parts) if parts else None


def _detect_device_and_model() -> tuple[str, str, str]:
    """Return (device, model, compute_type) honoring config but auto-downgrading
    to CPU + smaller model when CUDA is unavailable. Lets the same source tree
    target Windows-CUDA, Windows-CPU, and (via the Mac backend below) macOS-Metal."""
    req_device = CFG.get("whisper_device", "cuda")
    req_model = CFG.get("whisper_model", "large-v3")
    req_compute = CFG.get("whisper_compute_type", "float16")

    if req_device != "cuda":
        return req_device, req_model, req_compute

    try:
        import ctranslate2  # type: ignore[import-not-found]
        if ctranslate2.get_cuda_device_count() > 0:
            return req_device, req_model, req_compute
    except Exception:
        pass

    # No CUDA — downgrade. large-v3 on CPU is too slow; fall back to small.
    print("[whisper] CUDA unavailable — falling back to CPU + small int8")
    return "cpu", "small", "int8"


class _FasterWhisperBackend:
    """Windows / Linux backend. CUDA-accelerated on Nvidia, CPU-fallback otherwise."""

    def __init__(self, on_log: Callable[[str], None]):
        device, model_name, compute_type = _detect_device_and_model()
        self.key = (device, model_name, compute_type)
        on_log(f"[whisper] loading model={model_name} device={device} compute={compute_type} (faster-whisper)...")
        t0 = time.time()
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)
        on_log(f"[whisper] ready ({time.time() - t0:.1f}s)")

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=CFG.get("language") or ((CFG.get("languages") or [None])[0] if len(CFG.get("languages") or []) == 1 else None),
            beam_size=CFG.get("beam_size", 1),
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 250},
            condition_on_previous_text=False,
            without_timestamps=True,  # skips timestamp-token decoding; pure speed win for dictation
            initial_prompt=_build_initial_prompt(),
        )
        return " ".join(seg.text.strip() for seg in segments).strip()


class _WhisperCppBackend:
    """macOS backend via pywhispercpp (whisper.cpp + Metal acceleration).

    Model files are auto-downloaded to ``~/Library/Application Support/NoMoreWriting/models``
    on first run; subsequent launches load from cache. Universal binary — works on
    Apple Silicon and Intel Macs (Metal falls back to CPU on Intel without GPU)."""

    # Whisper-flow config uses HuggingFace-style names ("large-v3"); whisper.cpp uses
    # ggml file names. Map between them so the same config.json drives both backends.
    _MODEL_MAP = {
        "tiny": "tiny",
        "base": "base",
        "small": "small",
        "medium": "medium",
        "large": "large-v3",
        "large-v3": "large-v3",
        "large-v3-turbo": "large-v3-turbo",
        "turbo": "large-v3-turbo",
        "large-v2": "large-v2",
    }

    def __init__(self, on_log: Callable[[str], None]):
        req_model = CFG.get("whisper_model", "large-v3")
        wcpp_model = self._MODEL_MAP.get(req_model, "large-v3")
        on_log(f"[whisper] loading model={wcpp_model} backend=whisper.cpp+Metal ...")
        t0 = time.time()
        # Lazy import — keeps the Windows build from pulling in pywhispercpp.
        from pywhispercpp.model import Model  # type: ignore[import-not-found]
        # pywhispercpp downloads to ~/Library/Application Support/pywhispercpp/models by default.
        # The download is one-shot per model; we leave its default cache dir untouched.
        self.model = Model(
            wcpp_model,
            n_threads=4,
            print_realtime=False,
            print_progress=False,
        )
        on_log(f"[whisper] ready ({time.time() - t0:.1f}s)")

    def transcribe(self, audio: np.ndarray) -> str:
        # pywhispercpp expects float32 mono PCM at 16kHz — same shape Recorder produces.
        langs = CFG.get("languages") or []
        forced = CFG.get("language") or (langs[0] if len(langs) == 1 else None)
        kwargs = {"initial_prompt": _build_initial_prompt() or ""}
        if forced:
            kwargs["language"] = forced
        else:
            # auto-detect; whisper.cpp picks per-segment language
            kwargs["language"] = "auto"
        segments = self.model.transcribe(audio.astype(np.float32), **kwargs)
        return " ".join((seg.text or "").strip() for seg in segments).strip()


class Transcriber:
    """Front-end wrapper that picks the right backend per OS at startup."""

    def __init__(self, on_log: Callable[[str], None] | None = None):
        self._log = on_log or print
        if IS_MAC:
            self.backend = _WhisperCppBackend(self._log)
        else:
            self.backend = _FasterWhisperBackend(self._log)

    def reload_if_changed(self) -> bool:
        """Rebuild the backend when the configured model/device no longer matches
        the loaded one (speed preset change). Returns True if a reload happened."""
        if IS_MAC:
            return False
        if getattr(self.backend, "key", None) == _detect_device_and_model():
            return False
        old = self.backend
        self.backend = _FasterWhisperBackend(self._log)
        del old  # free the previous model's VRAM
        return True

    def transcribe(self, audio: np.ndarray) -> str:
        return self.backend.transcribe(audio)


# ---------- Cleanup via Ollama ----------

CLEANUP_PROMPT_TEMPLATE = """You are a dictation punctuation engine for a Spanish/English bilingual speaker who code-switches mid-sentence. The user dictated the text below. Your ONLY job is punctuation and hesitation removal:
- Add missing punctuation: periods, commas, question marks, exclamation marks.
- Spanish questions MUST be wrapped ¿...? — the ¿ opens where the question clause starts (e.g. ", ¿me entiendes?"). English questions never get ¿.
- Split run-on speech into natural sentences.
- Capitalize sentence starts and proper nouns.
- DELETE pure hesitation sounds entirely: eh, ehh, uh, um, mmm, hmm, ahh, err. Do not keep them as interjections.
- Fix an obviously misrecognized word only when the correction is certain from context.

PRESERVE THE SPEAKER'S VOICE. These are intentional expressions, NEVER remove or reword them: {expressions}.

STRICT RULES:
- Every dictated word must appear in the output (except deleted hesitations). Do NOT drop words like "de", "como", "que" even if they sound redundant — "prefiero de que" stays "prefiero de que".
- Do NOT change verb forms, word order, or word choice. Do NOT add words.
- Do NOT rephrase, summarize, or shorten.
- ABSOLUTELY NO TRANSLATION. This speaker mixes English phrases inside Spanish sentences on purpose. Every English word stays in English, every Spanish word stays in Spanish, exactly where dictated.
- Preserve these personal vocabulary terms exactly, case-sensitive: {vocab}
- FORBIDDEN: any commentary, notes, explanations, parenthetical remarks, or prefixes ("Cleaned:", "Note:", "I've preserved...", "Translation:", quotation marks, etc.). The user pastes your output directly into their app — any extra text breaks the workflow.
- Your response MUST start with the first character of the cleaned text and end with the last. Nothing else.
- If the transcript is already clean, return it unchanged.

EXAMPLES:
Input: esto es un ejemplo de what I want to do o sea the full flow no cambia
Output: Esto es un ejemplo de what I want to do, o sea, the full flow no cambia.
Input: eh quiero que el botón sea uh más grande me entiendes
Output: Quiero que el botón sea más grande, ¿me entiendes?
Input: revisa los estilos de la página no
Output: Revisa los estilos de la página, ¿no?

Raw transcript:
{text}

Cleaned text:"""


# Discourse markers that are part of the user's dictation voice. The cleanup
# prompt tells the model to preserve these verbatim; they are NOT fillers.
# Overridable via the "expressions" list in config.json.
DEFAULT_EXPRESSIONS = [
    "you know", "like", "ok", "so", "basically",
]


def _expressions_str() -> str:
    exprs = CFG.get("expressions") or DEFAULT_EXPRESSIONS
    return ", ".join(f'"{e}"' for e in exprs)


# Strip trailing commentary blocks the LLM sometimes adds despite instructions.
_TRAILING_NOTE_RE = re.compile(
    r"\s*(?:\n\n+|\s+)\(?\s*(?:Note|Nota|Translation|Traducci[oó]n|I'?ve|I've preserved|Notes?|Comment)[^\n]*$",
    re.IGNORECASE,
)


# Fast-path routing: skip Ollama when text can be normalized cheaply.
# NOTE: "este" is intentionally NOT here. In Spanish it is overwhelmingly the
# demonstrative ("ser este", "este proyecto"), not a hesitation. Listing it routed
# every sentence containing it through the cleanup LLM, which on short inputs
# collapsed the whole transcript to a stray token like "E." Real "esteee"
# hesitations are still handled by the LLM when other fillers co-occur.
# NOTE 2: "o sea", "pues", "you know", "like" were REMOVED from this regex —
# they are the user's discourse markers (1600+ uses of "o sea" in history),
# not fillers. Their presence alone doesn't justify an LLM round-trip.
FILLER_RE = re.compile(
    r"\b(uh+|um+|eh+|mmm+|hmm+|ahh+|err+)\b",
    re.IGNORECASE,
)

_PUNCT_SPLIT_RE = re.compile(r"[.,;:!?¿¡\n]")


def _longest_unpunctuated_run(text: str) -> int:
    """Longest stretch of words carrying no punctuation at all."""
    return max((len(seg.split()) for seg in _PUNCT_SPLIT_RE.split(text)), default=0)


# Across ~5000 real dictations the median longest-unpunctuated-run is 14 words,
# so anything past ~12 means Whisper dropped internal punctuation and the text
# needs the LLM to restore sentence and clause boundaries. Lower = better
# punctuation, more LLM calls; raise it in config.json to trade back for speed.
DEFAULT_RUNON_THRESHOLD = 12


def fast_normalize(text: str) -> str | None:
    """If text needs no LLM (no hesitations, reasonably punctuated), normalize
    with regex (instant). Else None (LLM needed)."""
    if not text:
        return ""
    if FILLER_RE.search(text):
        return None  # LLM needed to remove hesitations
    threshold = CFG.get("runon_word_threshold", DEFAULT_RUNON_THRESHOLD)
    if _longest_unpunctuated_run(text) > threshold:
        return None  # run-on — LLM needed to restore punctuation
    if CFG.get("structure_enabled", True) and needs_llm_for_structure(text):
        return None  # spoken ordering that needs punctuation before it resolves
    t = text.strip()
    # Capitalize first letter of the whole utterance
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    # Ensure terminal punctuation
    if t and t[-1] not in ".!?,":
        t += "."
    return t



# ---------- Speed / quality presets ----------
# One knob for the user: 1 = fastest, 5 = most accurate. Each level writes the
# underlying config keys so the rest of the pipeline stays preset-agnostic.
# Measured on history.jsonl (RTX 5090): large-v3 median 1.2s / p90 3.5s per
# dictation; large-v3-turbo is ~3-4x faster at near-identical accuracy. The LLM
# pass (gemma3:12b) adds 0.7-2s median when it runs, so the lower levels route
# fewer dictations to it (higher run-on threshold) or skip it entirely.
SPEED_PRESETS: dict[int, dict] = {
    1: dict(label="Fastest",   whisper_model="large-v3-turbo", beam_size=1, llm_enabled=False, runon_word_threshold=999),
    2: dict(label="Fast",      whisper_model="large-v3-turbo", beam_size=1, llm_enabled=True,  runon_word_threshold=20),
    3: dict(label="Balanced",  whisper_model="large-v3-turbo", beam_size=1, llm_enabled=True,  runon_word_threshold=12),
    4: dict(label="Accurate",  whisper_model="large-v3",       beam_size=1, llm_enabled=True,  runon_word_threshold=12),
    5: dict(label="Maximum",   whisper_model="large-v3",       beam_size=5, llm_enabled=True,  runon_word_threshold=8),
}
SPEED_PRESET_KEYS = ("whisper_model", "beam_size", "llm_enabled", "runon_word_threshold")
SPEED_PRESET_DESCRIPTIONS: dict[int, str] = {
    1: "Turbo Whisper, no LLM pass. Regex punctuation only. ~0.3-0.8s.",
    2: "Turbo Whisper, LLM only on long run-on speech. ~0.5-1.5s.",
    3: "Turbo Whisper + LLM on normal run-ons. Best everyday trade-off. ~0.7-2s.",
    4: "Full large-v3 Whisper + LLM. Previous default. ~1.5-4s.",
    5: "Large-v3 with beam search 5 + aggressive LLM routing. Slowest. ~3-8s.",
}


def _preset_default(key: str):
    return {"whisper_model": "large-v3", "beam_size": 1, "llm_enabled": True,
            "runon_word_threshold": DEFAULT_RUNON_THRESHOLD}[key]


def apply_speed_preset(level: int) -> None:
    """Write the preset's keys into CFG (caller saves + reloads models)."""
    level = max(1, min(5, int(level)))
    preset = SPEED_PRESETS[level]
    for k in SPEED_PRESET_KEYS:
        CFG[k] = preset[k]
    CFG["speed_level"] = level


def current_speed_level() -> int | None:
    """Return the preset level matching CFG, or None if keys were hand-edited."""
    for level, preset in SPEED_PRESETS.items():
        if all(CFG.get(k, _preset_default(k)) == preset[k] for k in SPEED_PRESET_KEYS):
            return level
    return None


# ---------- LLM output sanity guards ----------

_WORD_TOKEN_RE = re.compile(r"[a-zA-Z0-9áéíóúñüÁÉÍÓÚÑÜ']+")
_HESITATION_TOKENS = {"uh", "um", "eh", "ehh", "mmm", "hmm", "ahh", "err"}
# 6+ consecutive single-letter tokens = the model letter-spaced the text
# ("L a t e r m i n a l ..."), a real llama3.2:3b failure mode from history.
_LETTER_SPACED_RE = re.compile(r"(?:\b\w[\s.,]+){6,}")


# Hesitations the LLM was told to delete but sometimes leaves behind. Only the
# unambiguous ones — a bare "eh" can be a real Spanish tag question ("¿eh?"), so
# it stays the LLM's call. Leading punctuation is absorbed so "bien, mmm en la
# parte" collapses cleanly to "bien en la parte".
_LEFTOVER_HESITATION_RE = re.compile(
    r"(?:(?<=[\s,;:])|^)\s*\b(?:uh+|um+|mmm+|hmm+|ahh+|err+|ehh+)\b[\s,;:]*",
    re.IGNORECASE,
)

# Some models "typographically improve" apostrophes and quotes. The user pastes
# into code, prompts, and terminals — straight characters only.
_SMART_CHARS = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...",
}


def polish(text: str) -> str:
    """Deterministic cleanup applied to LLM output: drop leftover hesitations,
    normalize smart punctuation, tidy the spacing those edits leave behind."""
    if not text:
        return text
    for bad, good in _SMART_CHARS.items():
        text = text.replace(bad, good)
    text = _LEFTOVER_HESITATION_RE.sub(" ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def _token_retention(src: str, out: str) -> float:
    """Fraction of source words (len>=3, hesitations excluded) that survive in
    the output. Cleanup only punctuates and deletes hesitations, so retention
    should be ~1.0. A low score means the model translated, summarized, or
    dropped content — all forbidden."""
    src_counts: dict[str, int] = {}
    for w in _WORD_TOKEN_RE.findall(src.lower()):
        if len(w) >= 3 and w not in _HESITATION_TOKENS:
            src_counts[w] = src_counts.get(w, 0) + 1
    if not src_counts:
        return 1.0
    out_counts: dict[str, int] = {}
    for w in _WORD_TOKEN_RE.findall(out.lower()):
        out_counts[w] = out_counts.get(w, 0) + 1
    kept = sum(min(c, out_counts.get(w, 0)) for w, c in src_counts.items())
    return kept / sum(src_counts.values())


def _regex_fallback(text: str) -> str:
    """Non-destructive normalization of the raw transcript: capitalize + terminal period."""
    t = text.strip()
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    if t and t[-1] not in ".!?,":
        t += "."
    return t


class Cleaner:
    def __init__(self, on_log: Callable[[str], None] | None = None):
        log = on_log or print
        self.on_log = log
        self.enabled = CFG.get("cleanup_enabled", True)
        if not self.enabled:
            log("[ollama] cleanup disabled")
            return
        try:
            import ollama
            self.ollama = ollama
            self.model = CFG["ollama_model"]
            log(f"[ollama] warming {self.model}...")
            t0 = time.time()
            # Send a real cleanup-template call so the prompt-cache is primed.
            # First inference after model load is always slow; doing it now (not on first dictation) hides that cost.
            warmup_prompt = CLEANUP_PROMPT_TEMPLATE.format(
                text="hola mundo", vocab="(none)", expressions=_expressions_str())
            self.ollama.generate(
                model=self.model, prompt=warmup_prompt,
                keep_alive=-1,
                options={"num_predict": 8, "num_ctx": CFG.get("ollama_num_ctx", 8192), "temperature": 0.0, "seed": 42},
            )
            log(f"[ollama] ready ({time.time() - t0:.1f}s)")
        except Exception as e:
            log(f"[ollama] WARN: {e}. Cleanup disabled.")
            self.enabled = False

    def clean(self, text: str) -> tuple[str, bool]:
        """Return (cleaned_text, ran_llm)."""
        if not self.enabled or not text:
            return text, False
        if CFG.get("fast_path_enabled", True):
            fast = fast_normalize(text)
            if fast is not None:
                return fast, False
        if not CFG.get("llm_enabled", True):
            # Speed preset 1: never call the LLM; deterministic normalization only.
            return _regex_fallback(text), False
        try:
            vocab = CFG.get("vocabulary") or []
            vocab_str = ", ".join(vocab) if vocab else "(none specified)"
            prompt = CLEANUP_PROMPT_TEMPLATE.format(
                text=text, vocab=vocab_str, expressions=_expressions_str())
            resp = self.ollama.generate(
                model=self.model,
                prompt=prompt,
                keep_alive=-1,  # never unload — critical for warm-call latency
                options={
                    "temperature": 0.0,
                    "num_predict": CFG.get("ollama_num_predict", 2048),
                    "seed": 42,
                    "num_ctx": CFG.get("ollama_num_ctx", 8192),
                },
            )
            cleaned = resp.get("response", "").strip()
            cleaned = cleaned.strip('"').strip("'").strip()
            # Strip trailing commentary the model snuck in despite instructions
            for _ in range(3):
                new = _TRAILING_NOTE_RE.sub("", cleaned).rstrip()
                if new == cleaned:
                    break
                cleaned = new
            # Also strip anything after a literal "\n\n(" — generic parenthetical-note marker
            if "\n\n(" in cleaned:
                cleaned = cleaned.split("\n\n(", 1)[0].rstrip()
            # Sanity guards: LLM cleanup must never lose or rewrite content.
            # On any suspicious output, fall back to a non-destructive regex
            # normalization of the RAW transcript instead of pasting damage.
            src = text.strip()
            out = cleaned.strip()
            reason = None
            if (not out) or (len(out) <= 3 and len(src) > 8):
                reason = "collapsed"
            elif len(src) > 40 and _LETTER_SPACED_RE.search(out) and not _LETTER_SPACED_RE.search(src):
                reason = "letter-spaced"
            elif len(src) > 40 and _token_retention(src, out) < 0.88:
                reason = f"content loss (retention {_token_retention(src, out):.2f})"
            if reason:
                self.on_log(f"[ollama] output rejected ({reason}); keeping raw")
                return _regex_fallback(src), False
            return (polish(cleaned) or text), True
        except Exception as e:
            print(f"[ollama] cleanup failed: {e}")
            return text, False


# ---------- Paste ----------

def copy_and_paste(text: str, auto_paste: bool) -> bool:
    if not text:
        return False
    pyperclip.copy(text)
    if auto_paste:
        send_paste_shortcut(delay_ms=50)
    return True


# ---------- Beeps ----------

def beep(freq: int, dur_ms: int):
    _platform_beep(freq, dur_ms, enabled=CFG.get("beep", True))


# ---------- Orchestrator ----------

class Flow:
    """Main orchestrator. Drive via toggle(); subscribe via on_state / on_transcript / on_log."""

    def __init__(
        self,
        on_state: Callable[[str], None] | None = None,
        on_transcript: Callable[[TranscriptEntry], None] | None = None,
        on_log: Callable[[str], None] | None = None,
    ):
        self.on_state = on_state or (lambda s: None)
        self.on_transcript = on_transcript or (lambda e: None)
        self.on_log = on_log or print

        self.recorder = Recorder(CFG["sample_rate"])
        self.transcriber = Transcriber(on_log=self.on_log)
        self.cleaner = Cleaner(on_log=self.on_log)

        self._state = State.IDLE
        self._lock = threading.Lock()
        threading.Thread(target=prerender_beeps, daemon=True).start()

    @property
    def state(self) -> str:
        return self._state

    def reload_models(self, on_done: Callable[[], None] | None = None):
        """Apply a speed-preset change without restarting the app. Runs in a
        worker thread; waits for any in-flight dictation to finish first."""
        def _work():
            try:
                _reload()
            finally:
                if on_done:
                    try:
                        on_done()
                    except Exception as ex:
                        self.on_log(f"[flow] reload callback failed: {ex}")

        def _reload():
            for _ in range(600):  # up to 60s for a PROCESSING dictation to drain
                if self._state != State.PROCESSING:
                    break
                time.sleep(0.1)
            try:
                if self.transcriber.reload_if_changed():
                    self.on_log("[whisper] model switched")
                if self.cleaner.enabled != CFG.get("cleanup_enabled", True):
                    self.cleaner = Cleaner(on_log=self.on_log)
                self.on_log("[flow] ready")
            except Exception as e:
                self.on_log(f"[flow] model reload failed: {e}")
        threading.Thread(target=_work, daemon=True).start()

    def _set_state(self, s: str):
        self._state = s
        try:
            self.on_state(s)
        except Exception as e:
            print(f"[flow] on_state callback failed: {e}")

    def toggle(self):
        with self._lock:
            if self._state == State.PROCESSING:
                self.on_log("[flow] busy, ignoring")
                return
            if self._state == State.IDLE:
                self._start_recording()
            elif self._state == State.RECORDING:
                self._stop_and_process()

    def cancel(self):
        """User aborted recording — discard audio, no paste, no history."""
        with self._lock:
            if self._state != State.RECORDING:
                return
            self.recorder.discard()
            beep(330, 60)
            self._set_state(State.IDLE)
            self.on_log("[flow] cancelled")

    def _start_recording(self):
        try:
            self.recorder.start()
        except Exception as e:
            # No usable microphone (device unplugged, disabled, or the OS has no
            # working input endpoint). Fail loud, not silent — otherwise the
            # hotkey appears to do nothing at all. Stay IDLE so the next press
            # retries cleanly once a mic is reconnected.
            beep(220, 220)
            self._set_state(State.IDLE)
            self.on_log(f"[flow] no microphone available — recording not started ({e})")
            return
        beep(880, 80)
        self._set_state(State.RECORDING)
        self.on_log("[flow] recording...")

    def _stop_and_process(self):
        audio = self.recorder.stop()
        beep(660, 80)
        if audio is None or len(audio) < CFG["sample_rate"] * 0.3:
            self.on_log("[flow] too short, ignoring")
            self._set_state(State.IDLE)
            return
        # Bring quiet recordings up to a healthy level BEFORE VAD + Whisper see them — quiet
        # speech otherwise loses words (the "I have to shout" symptom).
        raw_peak = float(np.max(np.abs(audio)))
        audio, gain = condition_audio(audio)
        if gain > 1.0:
            self.on_log(f"[audio] level raised x{gain:.1f} (+{20 * np.log10(gain):.0f} dB) "
                        f"from {self.recorder.active_device or 'mic'}")
        self._set_state(State.PROCESSING)
        threading.Thread(target=self._process, args=(audio, raw_peak, gain), daemon=True).start()

    def _process(self, audio: np.ndarray, raw_peak: float = 0.0, gain: float = 1.0):
        t0 = time.time()
        try:
            t_w0 = time.time()
            raw = self.transcriber.transcribe(audio)
            whisper_ms = int((time.time() - t_w0) * 1000)
            self.on_log(f"[whisper] {whisper_ms}ms -> {raw!r}")
            if not raw:
                beep(220, 200)
                return

            t_o0 = time.time()
            cleaned, ran_llm = self.cleaner.clean(raw)
            ollama_ms = int((time.time() - t_o0) * 1000)
            self.on_log(f"[ollama]  {ollama_ms}ms{'  (fast-path skip)' if not ran_llm else ''} -> {cleaned!r}")
            if ran_llm and ollama_ms > 8000:
                self.on_log("[ollama] WARN: very slow call - model was likely evicted from VRAM "
                            "(GPU memory pressure from other apps, e.g. DaVinci Resolve / browsers)")

            # Smart structure — deterministic, runs on the final text so the
            # LLM can never mangle the formatting. Marker punctuation first so
            # the boundaries it creates are visible to structure detection;
            # then "nueva línea" → line break; then "parte 1 ... parte 2" →
            # formatted sections / numbered lists.
            if CFG.get("marker_punctuation_enabled", True):
                cleaned = punctuate_markers(cleaned)
            if CFG.get("voice_commands_enabled", True):
                cleaned = apply_voice_commands(cleaned)
            if CFG.get("structure_enabled", True):
                structured = apply_structure(cleaned)
                if structured != cleaned:
                    self.on_log("[structure] sectioned output")
                    cleaned = structured

            pasted = copy_and_paste(cleaned, CFG.get("auto_paste", True))
            total_ms = int((time.time() - t0) * 1000)
            self.on_log(f"[flow] total {total_ms}ms | pasted {len(cleaned)} chars")

            entry = TranscriptEntry(
                timestamp=time.time(),
                raw=raw,
                cleaned=cleaned,
                whisper_ms=whisper_ms,
                ollama_ms=ollama_ms,
                total_ms=total_ms,
                pasted=pasted,
                peak_db=round(20 * float(np.log10(max(raw_peak, 1e-6))), 1),
                gain_db=round(20 * float(np.log10(max(gain, 1.0))), 1),
            )
            try:
                self.on_transcript(entry)
            except Exception as e:
                self.on_log(f"[flow] on_transcript callback failed: {e}")
        except Exception as e:
            self.on_log(f"[flow] error: {e}")
            beep(220, 200)
        finally:
            self._set_state(State.IDLE)


# ---------- Hotkey helper ----------

def register_hotkey(hotkey: str, callback: Callable[[], None]):
    """Register a system-wide hotkey. Picks the best per-OS backend.

    Windows: Win32 RegisterHotKey (with pynput as fallback).
    macOS / Linux: pynput.keyboard.GlobalHotKeys (macOS prompts for Accessibility
    permission on first use)."""
    from hotkey import register_hotkey as _register
    if not _register(hotkey, callback):
        print(f"[hotkey] FATAL: could not register '{hotkey}' on any backend")
