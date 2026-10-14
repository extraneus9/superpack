"""
Smart dictation structure — deterministic post-processing that turns spoken
ordering ("parte 1 ... parte 2", "paso uno ... paso dos") into formatted text,
plus explicit voice commands ("nueva línea", "nuevo párrafo").

Runs AFTER cleanup, on the final text. Deliberately NOT LLM-based: the local
3B cleanup model is too unreliable for formatting, and these rules must never
mangle text that doesn't contain commands.

False-positive safety (based on real dictation history):
  - "por ejemplo, la parte 1 lleva el slide 1"  → referential, untouched
    (marker preceded by article/preposition: la/el/de/en/the/of/...)
  - "hay bastantes partes de estas secciones"   → no number, untouched
  - Markers must start at 1 and count up (1, 2, 3…) — a lone "punto tres"
    mid-sentence never triggers.
"""

from __future__ import annotations

import re

# ---------- number words ----------

_NUM_WORDS = {
    # Spanish
    "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
    "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10,
    "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15,
    # English
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
}


def _parse_num(token: str) -> int | None:
    token = token.lower()
    if token.isdigit():
        return int(token)
    return _NUM_WORDS.get(token)


# ---------- marker detection ----------

# Header-style kinds render as "Parte 1:" section titles;
# list-style kinds render as "1. ..." numbered lines.
_HEADER_KINDS = {
    "parte", "part", "seccion", "sección", "section",
    "capitulo", "capítulo", "chapter", "escena", "scene",
}
_LIST_KINDS = {
    "paso", "step", "punto", "point", "numero", "número", "number",
    "opcion", "opción", "option",
}

_KIND_ALT = (
    r"parte|part|secci[oó]n|section|cap[ií]tulo|chapter|escena|scene|"
    r"paso|step|punto|point|n[uú]mero|number|opci[oó]n|option"
)
_NUM_ALT = r"\d{1,3}|" + "|".join(_NUM_WORDS)

MARKER_RE = re.compile(
    rf"\b(?P<kind>{_KIND_ALT})\s+(?P<num>{_NUM_ALT})\b",
    re.IGNORECASE,
)

# If the marker is immediately preceded by one of these, it's the user
# TALKING ABOUT a part, not declaring one: "la parte 2", "en la sección 3",
# "of part 1". Also quotes/parens.
_REFERENTIAL_TAIL = re.compile(
    r"(?:\b(?:la|las|el|los|una|un|unas|unos|esa|esas|ese|esos|esta|estas|este|estos|"
    r"de|del|en|a|al|mi|tu|su|cada|otra|otro|misma|mismo|primera|primer|segunda|segundo|"
    r"the|that|this|these|those|of|in|to|at|my|your|each|other|same|first|second|which|cu[aá]l)\s+"
    r"|[\"'(\[])$",
    re.IGNORECASE,
)

# The marker must sit at a sentence boundary: start of text, or after
# . ! ? : ; ¡ ¿ , or a newline (commas allowed — dictation punctuation is
# soft: "ok, parte uno, hoy vamos a...").
_BOUNDARY_TAIL = re.compile(r"(?:^|[.!?:;,¡¿\n])\s*$")


def _find_command_markers(text: str) -> list[re.Match]:
    """Markers that look like real sectioning commands (position + no article)."""
    out = []
    for m in MARKER_RE.finditer(text):
        before = text[: m.start()]
        if _REFERENTIAL_TAIL.search(before):
            continue
        if not _BOUNDARY_TAIL.search(before):
            continue
        if _parse_num(m.group("num")) is None:
            continue
        out.append(m)
    return out


def _validate_sequence(markers: list[re.Match], text: str) -> bool:
    """Only structure when the numbers behave like an intentional sequence:
    ≥2 markers counting up from 1 (restarts allowed for nested groups), or a
    single 'X 1' marker near the start of the utterance."""
    nums = [_parse_num(m.group("num")) for m in markers]
    if not nums or nums[0] != 1:
        return False
    if len(nums) == 1:
        # "Parte uno. <content>" as the opening of the dictation.
        return markers[0].start() <= 20
    prev = nums[0]
    for n in nums[1:]:
        if n != prev + 1 and n != 1:  # count up, or restart a new group at 1
            return False
        prev = n
    return True


def needs_llm_for_structure(text: str) -> bool:
    """True when the text looks like a spoken ordering sequence ("paso uno …
    paso dos") that detection can't see because Whisper left out the sentence
    punctuation the markers need to sit behind. The caller routes these through
    the LLM first; once it restores the boundaries, apply_structure fires.

    A referential false positive ("la parte 1 … la parte 2") costs one LLM call
    and nothing else — the article guard still keeps it unformatted."""
    if len(MARKER_RE.findall(text)) < 2:
        return False
    return not _validate_sequence(_find_command_markers(text), text)


# ---------- formatting ----------

_LEAD_SEP = re.compile(r"^[\s.,:;\-—]+")
_TRAIL_SEP = re.compile(r"[\s,;\-—]+$")


def _clean_segment(seg: str) -> str:
    seg = _LEAD_SEP.sub("", seg)
    seg = _TRAIL_SEP.sub("", seg).strip()
    if seg and seg[0].islower():
        seg = seg[0].upper() + seg[1:]
    return seg


def _display_kind(kind: str) -> str:
    k = kind.strip()
    return k[0].upper() + k[1:].lower()


def apply_structure(text: str) -> str:
    """Turn spoken 'parte 1 ... parte 2' ordering into formatted sections.
    Returns text unchanged unless a valid command sequence is detected."""
    if not text or len(text) < 8:
        return text
    markers = _find_command_markers(text)
    if not _validate_sequence(markers, text):
        return text

    blocks: list[str] = []
    intro = _clean_segment(text[: markers[0].start()])
    if intro:
        blocks.append(intro)

    for i, m in enumerate(markers):
        end = markers[i + 1].start() if i + 1 < len(markers) else len(text)
        content = _clean_segment(text[m.end():end])
        kind = m.group("kind").lower()
        num = _parse_num(m.group("num"))
        if kind in _LIST_KINDS:
            blocks.append(f"{num}. {content}")
        else:
            blocks.append(f"{_display_kind(m.group('kind'))} {num}:\n{content}")

    # Headers get a blank line between blocks; consecutive list items stay tight.
    def _is_list_item(b: str) -> bool:
        return bool(re.match(r"^\d+\. ", b))

    out: list[str] = []
    for i, b in enumerate(blocks):
        if i == 0:
            out.append(b)
        elif _is_list_item(b) and _is_list_item(blocks[i - 1]):
            out.append("\n" + b)
        else:
            out.append("\n\n" + b)
    return "".join(out)


# ---------- voice commands ----------

_NEWPARA_RE = re.compile(
    r"[,.;:]?\s*\b(?:nuevo\s+p[aá]rrafo|punto\s+y\s+aparte|new\s+paragraph)\b[,.;:]?\s*",
    re.IGNORECASE,
)
_NEWLINE_RE = re.compile(
    r"[,.;:]?\s*\b(?:nueva\s+l[ií]nea|new\s+line)\b[,.;:]?\s*",
    re.IGNORECASE,
)

# "la nueva línea de productos" / "the new paragraph of the doc" — the user is
# TALKING ABOUT a line/paragraph, not commanding one. Preceding article or a
# following possessive/prepositional continuation disqualifies the match.
_CMD_REFERENTIAL_TAIL = re.compile(
    r"\b(?:la|las|una|unas|esa|esta|the|a|this|that|my|mi|su|your)\s+$",
    re.IGNORECASE,
)
_CMD_REFERENTIAL_HEAD = re.compile(
    r"^\s*(?:de|del|of)\b",
    re.IGNORECASE,
)


def _sub_command(rx: re.Pattern, replacement: str, text: str) -> str:
    out: list[str] = []
    pos = 0
    for m in rx.finditer(text):
        # The leading [,.;:]? in the pattern may swallow the char right after
        # the previous word — inspect the text before the match itself.
        before = text[: m.start()]
        after = text[m.end():]
        if _CMD_REFERENTIAL_TAIL.search(before) or _CMD_REFERENTIAL_HEAD.match(after):
            continue
        out.append(text[pos: m.start()])
        out.append(replacement)
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


# ---------- discourse-marker punctuation ----------

# The two heaviest parenthetical markers in real dictation history ("o sea"
# ~1600 uses, "me entiendes" ~640). Both are ALWAYS parenthetical in Spanish, so
# comma-wrapping them is safe without any semantic check — unlike "entonces" or
# "obviamente", which legitimately open a sentence with no comma. Whisper rarely
# punctuates them, and fixing them here means the common case never needs an
# LLM round-trip.
# The lookbehind must exclude EVERY sentence-punctuation character, terminal
# ones included — "¿cuánto cuesta? O sea, ..." is already correctly punctuated
# and must not be rewritten. The optional trailing comma is consumed so an
# existing "o sea," never doubles up.
_OSEA_RE = re.compile(r"(?<![,.;:!?¡¿(\[\n])(\s+)(o sea)\b,?(\s*)", re.IGNORECASE)

# "me entiendes" / "you know" as a trailing tag question: "...más grande me
# entiendes" → "...más grande, ¿me entiendes?". Only at the very end, where it
# can't be the verb in a real clause ("no me entiendes nada").
_TAG_TAIL_RE = re.compile(
    r"(?<![,.;:!?¡¿\n])(\s+)(me entiendes|you know)\s*([.!?]?)\s*$",
    re.IGNORECASE,
)


def punctuate_markers(text: str) -> str:
    """Comma-wrap the speaker's parenthetical discourse markers. Deterministic
    and idempotent — a marker already preceded by punctuation is left alone."""
    if not text:
        return text

    def _tag(m: re.Match) -> str:
        phrase = m.group(2)
        if phrase.lower() == "you know":
            return f", {phrase}?"
        return f", ¿{phrase}?"

    text = _TAG_TAIL_RE.sub(_tag, text)

    def _osea(m: re.Match) -> str:
        return f", {m.group(2).lower()}," + m.group(3)

    new = _OSEA_RE.sub(_osea, text)
    if new == text:
        return text
    # Only tidy up after we actually inserted something, so untouched text is
    # never reshaped: drop a comma left sitting against terminal punctuation,
    # and close an utterance that now ends on the marker's trailing comma.
    new = re.sub(r",(\s*)([.!?])", r"\2", new)
    new = re.sub(r",\s*$", ".", new)
    return new


def apply_voice_commands(text: str) -> str:
    """Replace spoken 'nueva línea' / 'nuevo párrafo' with real line breaks."""
    if not text:
        return text
    text = _sub_command(_NEWPARA_RE, "\n\n", text)
    text = _sub_command(_NEWLINE_RE, "\n", text)
    # Capitalize the first letter after each inserted break.
    text = re.sub(
        r"\n([a-záéíóúñü])",
        lambda m: "\n" + m.group(1).upper(),
        text,
    )
    return text.strip()
