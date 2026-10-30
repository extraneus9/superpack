"""Sentinel — classification layer.

Turns a pile of raw detections into a human answer: WHAT is this, and HOW sure are we?

  * malware_class : MALWARE | PUA | TEST | POLICY | SUSPECT | CLEAN
  * category      : ransomware, trojan-downloader, credential-theft, ...
  * confidence    : HIGH | MEDIUM | LOW
  * rationale     : one line explaining the call

The point is to stop crying wolf. A packed game crack/keygen/mod trips packing and entropy
signals but has no malicious BEHAVIOR — so when only "ambient" signals fire and the filename
looks like cracked software, we label it PUA (potentially unwanted) and DOWNGRADE the verdict
from MALICIOUS to SUSPICIOUS, instead of calling it a trojan. If any genuinely malicious
signal fires (credential theft, ransomware, a downloader, Defender-disable, a real multi-engine
VirusTotal hit, a YARA family match), it stays MALWARE regardless of the filename.
"""
from __future__ import annotations

from pathlib import Path

# Strong, behavior-based categories, in priority order (first match wins for the headline).
STRONG = [
    ("ransomware",          ["vss_shadow", "bcdedit_recovery", "wbadmin", "mass_crypto",
                             "ransom_note", "shadow_delete", "mass_rename_encrypt",
                             "cipher_wipe", "fsutil_usn"]),
    ("credential-theft",    ["mimikatz", "reg_save_sam", "comsvcs_minidump", "cred_ntds",
                             "cred_vaultcmd", "keylogger_api"]),
    ("trojan-downloader",   ["download_exec", "certutil_download", "bitsadmin", "mshta_remote",
                             "regsvr32_remote", "rundll32_js", "base64_embedded_pe",
                             "polyglot_image_pe", "ps_encoded_launcher"]),
    ("dropper-deception",   ["disguised_exe", "double_extension", "zip_path_traversal"]),
    ("defense-evasion",     ["disable_defender", "defender_exclusion", "amsi", "clear_eventlog",
                             "firewall_off", "etw_bypass", "defender_tamper"]),
    ("exploit-document",    ["doc_dde", "rtf_ole", "pdf_active", "office_macro_dropper",
                             "office_vba_project", "office_macro"]),
    ("backdoor-c2",         ["c2_pastebin", "exfil_dns"]),
    ("worm-spreader",       ["autorun_inf"]),
    ("infostealer",         ["screen_capture", "clipboard_hijack", "av_discovery", "discovery_"]),
    ("persistence",         ["schtasks", "persist_reg_run", "sc_create", "wmi_consumer",
                             "runonce", "reg_persistence", "startup_persistence",
                             "new_executable_dropped", "lnk_launcher", "wmic_create"]),
    ("phishing",            ["punycode", "rlo_filename"]),
]

AMBIENT = ["packed_pe", "upx_packed", "entropy_masquerade", "obfuscation", "hidden_window",
           "base64_embedded_zip", "deeply_nested_archive", "corrupt_archive", "zip_bomb",
           "trailing_space", "reserved_device", "raw_ip_url", "encrypted_archive_member"]

# YARA pack categories that mean "known malware family" (strong). Everything else — packers,
# capabilities, crypto, anti-debug — is informational and treated as an ambient signal only,
# so a UPX/packer YARA match on a game crack does NOT make it "malware".
FAMILY_YARA_PACKS = ["malware", "webshells", "exploit_kits", "maldocs",
                     "mobile_malware", "cve_rules", "ransomware", "email"]

TEST_TOKENS = ["eicar", "sentinel-lab", "sentinel_lab", "sim_marker", "lab_yara", "lab_marker"]
SECRET_TOKEN = "secret_"
PUA_NAME = ["crack", "keygen", "patch", "patcher", "trainer", "loader", "repack", "nocd",
            "cheat", "unlocker", "activator", "kms", "-mod", "_mod", "modmenu", "pirate"]

CATEGORY_LABEL = {
    "ransomware": "Ransomware",
    "credential-theft": "Credential theft",
    "trojan-downloader": "Trojan / downloader",
    "dropper-deception": "Dropper (disguised file)",
    "defense-evasion": "Defense evasion",
    "exploit-document": "Weaponized document",
    "backdoor-c2": "Backdoor / C2",
    "worm-spreader": "Worm / spreader",
    "infostealer": "Infostealer / recon",
    "persistence": "Persistence",
    "phishing": "Phishing / spoofing",
    "secret-exposure": "Secret exposure (DLP)",
    "test": "Test file",
    "packed-unknown": "Packed / obfuscated",
    "pua-cracked": "Cracked software / game mod",
    "multi-engine": "Flagged by multiple engines",
    "yara-family": "YARA family match",
}


def _tokens(res) -> str:
    return " ".join(f"{f.rule} {f.detail or ''}".lower() for f in res.findings)


def classify(res, name: str = "") -> None:
    """Set res.malware_class / category / confidence / rationale, and downgrade PUA verdicts."""
    blob = _tokens(res)
    fname = Path(name or res.path).name.lower()
    # a YARA hit counts as a malware FAMILY match only if it came from a malware pack;
    # packer/capability/crypto YARA matches are informational (ambient), not "malware"
    has_family_yara = any(f"yara.{pack}." in blob for pack in FAMILY_YARA_PACKS)
    has_ambient_yara = ("yara." in blob) and not has_family_yara
    has_yara = has_family_yara
    has_intel = "intel.virustotal" in blob
    has_secret = SECRET_TOKEN in blob
    is_test = any(t in blob for t in TEST_TOKENS)
    ambient_only_hits = [a for a in AMBIENT if a in blob]
    pua_name = any(t in fname for t in PUA_NAME)

    strong_cats = [cat for cat, toks in STRONG if any(t in blob for t in toks)]

    if res.verdict == "CLEAN":
        res.malware_class, res.category, res.confidence = "CLEAN", "", ""
        res.rationale = "no detections"
        return

    # 1. test artifacts (EICAR, our markers) — never report as real malware
    if is_test and not strong_cats:
        res.malware_class = "TEST"
        res.category = CATEGORY_LABEL["test"]
        res.confidence = "HIGH"
        res.rationale = "antivirus test artifact (EICAR / lab marker) — not real malware"
        return

    # 2. genuine malicious behavior / family / multi-engine → MALWARE
    if strong_cats or has_yara or has_intel:
        if strong_cats:
            cat = strong_cats[0]
            res.category = CATEGORY_LABEL[cat]
        elif has_intel:
            res.category = CATEGORY_LABEL["multi-engine"]
        else:
            res.category = CATEGORY_LABEL["yara-family"]
        res.malware_class = "MALWARE"
        strong_signals = len(strong_cats) + (1 if has_intel else 0) + (1 if has_yara else 0)
        res.confidence = "HIGH" if strong_signals >= 2 or has_intel else "MEDIUM"
        extra = []
        if has_yara:
            extra.append("YARA match")
        if has_intel:
            extra.append("VirusTotal engines")
        res.rationale = "malicious behavior detected" + (f" + {', '.join(extra)}" if extra else "")
        return

    # 3. secret / policy exposure (DLP) — not malware
    if has_secret:
        res.malware_class = "POLICY"
        res.category = CATEGORY_LABEL["secret-exposure"]
        res.confidence = "HIGH"
        res.rationale = "credential/secret found in file — data-leak risk, not malware"
        return

    # 4. only ambient signals (packing, entropy, obfuscation, packer-YARA) — no malicious behavior
    if ambient_only_hits or has_ambient_yara:
        if pua_name:
            res.malware_class = "PUA"
            res.category = CATEGORY_LABEL["pua-cracked"]
            res.confidence = "LOW"
            res.rationale = ("packed/obfuscated + crack/mod filename, but NO malicious behavior "
                             "— likely cracked software or a game mod, not a trojan")
            if res.verdict == "MALICIOUS":
                res.verdict = "SUSPICIOUS"   # don't call a mod a trojan
            return
        res.malware_class = "SUSPECT"
        res.category = CATEGORY_LABEL["packed-unknown"]
        res.confidence = "LOW"
        res.rationale = "packing/obfuscation only — unclassified; inspect before trusting"
        return

    # 5. anything else that flagged (e.g. phishing-only) — report its weak category
    if strong_cats := [cat for cat, toks in STRONG if any(t in blob for t in toks)]:
        res.category = CATEGORY_LABEL[strong_cats[0]]
    else:
        res.category = "Suspicious indicators"
    res.malware_class = "SUSPECT"
    res.confidence = "LOW"
    res.rationale = "suspicious indicators without confirmed malicious behavior"
