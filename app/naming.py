"""Filnamnssanering enligt spec: ta bort \\ / : * ? " < > |, behåll åäö, max ~120 tecken."""
import re
import unicodedata

FORBIDDEN = set('\\/:*?"<>|')


def sanitize(name: str, max_len: int = 120) -> str:
    name = unicodedata.normalize("NFC", name or "")
    name = "".join(ch for ch in name if ch not in FORBIDDEN and ord(ch) >= 32)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > max_len:
        name = name[:max_len].rstrip(" .")
    return name or "Namnlös"
