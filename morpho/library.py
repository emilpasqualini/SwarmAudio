"""The official Neutone model library: index, download, cache.

Neutone publishes no documented model API, so the index is scraped from the
model page at https://neutone.ai/fx/models, which carries every model's full
metadata as JSON embedded in the page. Each record has a `model_id`, and the
file itself is content-addressed under that id in Neutone's public storage
bucket. Both of those are observed, not contractual, so everything here fails
soft: a broken scrape leaves you with the bundled snapshot, and a broken
download leaves the slot empty rather than taking the rack down.

The snapshot in `models/index.json` is refreshed by `--refresh`; without it the
rack works offline from whatever is already in the cache.

Models are large. RAVE checkpoints run 25 MB to 270 MB, so downloads are
streamed to a temporary file, size-checked, and only then moved into place --
an interrupted download must never leave a half-written `.nm` that loads as a
corrupt model.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("morpho_rack.library")

MODELS_PAGE = "https://neutone.ai/fx/models"
STORAGE = "https://neutone.supabase.co/storage/v1/object/public/neutonefx/models"
USER_AGENT = "morpho_rack/1.0 (+swarmaudio)"
TIMEOUT = 30


class Entry:
    """One model in the library, and whether we already have it."""

    __slots__ = ("name", "model_id", "size", "mono", "tags", "description", "authors")

    def __init__(self, rec: dict) -> None:
        self.name = str(rec.get("model_name", "unknown"))
        self.model_id = str(rec.get("model_id", ""))
        self.size = int(rec.get("file_size", 0) or 0)
        self.mono = bool(rec.get("is_input_mono", True))
        self.tags = list(rec.get("tags") or [])
        self.description = str(rec.get("model_short_description", ""))
        self.authors = list(rec.get("model_authors") or [])

    @property
    def size_mb(self) -> float:
        return self.size / (1024 * 1024)

    def label(self) -> str:
        kind = "mono" if self.mono else "stereo"
        return f"{self.name}  ({self.size_mb:.0f} MB, {kind})"

    def to_dict(self) -> dict:
        return {
            "model_name": self.name,
            "model_id": self.model_id,
            "file_size": self.size,
            "is_input_mono": self.mono,
            "tags": self.tags,
            "model_short_description": self.description,
            "model_authors": self.authors,
        }


class Library:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.cache_dir / "index.json"
        self.entries: list[Entry] = []
        self.load()

    # -- index --------------------------------------------------------------

    def load(self) -> None:
        if not self.index_path.exists():
            return
        try:
            raw = json.loads(self.index_path.read_text(encoding="utf-8"))
            self.entries = [Entry(r) for r in raw if r.get("model_id")]
            log.info("model library: %d models in the index", len(self.entries))
        except Exception as exc:
            log.warning("could not read %s: %s", self.index_path, exc)

    def save(self) -> None:
        self.index_path.write_text(
            json.dumps([e.to_dict() for e in self.entries], indent=1), encoding="utf-8"
        )

    def refresh(self) -> int:
        """Re-scrape the model page. Returns how many models were found."""
        req = urllib.request.Request(MODELS_PAGE, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            page = r.read().decode("utf-8", errors="replace")
        records = _scrape(page)
        if not records:
            raise RuntimeError(
                "found no models on the page; its format has probably changed"
            )
        self.entries = [Entry(r) for r in records]
        self.entries.sort(key=lambda e: e.name.lower())
        self.save()
        log.info("model library: refreshed, %d models", len(self.entries))
        return len(self.entries)

    # -- files --------------------------------------------------------------

    def path_for(self, entry: Entry) -> Path:
        # Keep the readable name in the filename, but key on the id so two
        # versions of a model cannot collide.
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", entry.name)[:48]
        return self.cache_dir / f"{safe}.{entry.model_id[:8]}.nm"

    def have(self, entry: Entry) -> bool:
        p = self.path_for(entry)
        if not p.exists():
            return False
        # A truncated file from a killed download would load as a corrupt
        # model, so treat a size mismatch as not having it.
        return entry.size == 0 or abs(p.stat().st_size - entry.size) <= 4096

    def downloaded(self) -> list[Entry]:
        return [e for e in self.entries if self.have(e)]

    def fetch(
        self,
        entry: Entry,
        progress: Optional[Callable[[int, int], None]] = None,
        cancel: Optional[Callable[[], bool]] = None,
    ) -> Path:
        """Download one model into the cache and return its path."""
        dest = self.path_for(entry)
        if self.have(entry):
            return dest

        url = f"{STORAGE}/{entry.model_id}"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        tmp = None
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                total = int(r.headers.get("Content-Length") or entry.size or 0)
                fd, tmp_name = tempfile.mkstemp(dir=str(self.cache_dir), suffix=".part")
                tmp = Path(tmp_name)
                got = 0
                with os.fdopen(fd, "wb") as f:
                    while True:
                        if cancel is not None and cancel():
                            raise RuntimeError("cancelled")
                        chunk = r.read(1 << 16)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if progress is not None:
                            progress(got, total)
            if total and abs(got - total) > 4096:
                raise RuntimeError(f"short download: {got} of {total} bytes")
            # Move into place only once the bytes are all there.
            shutil.move(str(tmp), str(dest))
            tmp = None
            log.info("downloaded %s (%.1f MB)", entry.name, got / (1024 * 1024))
            return dest
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{entry.name}: HTTP {exc.code} from the model store")
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{entry.name}: cannot reach the model store ({exc.reason})")
        finally:
            if tmp is not None and tmp.exists():
                tmp.unlink()

    def local_files(self) -> list[Path]:
        """Every .nm in the cache, including ones loaded by hand."""
        return sorted(self.cache_dir.glob("*.nm"))


# ---------------------------------------------------------------------------
# scraping
# ---------------------------------------------------------------------------

BACKSLASH = chr(92)


def _scrape(page: str) -> list[dict]:
    """Pull every model record out of the page's embedded JSON.

    The page is a Next.js app and its data arrives as escaped JSON inside
    script tags, so the quotes are unescaped first and then each `{"model_name"
    ...}` object is taken by brace matching. A regex cannot do this: the records
    contain nested objects and strings with braces in them.
    """
    s = page.replace(BACKSLASH + '"', '"').replace(BACKSLASH + "u0026", "&")
    out, seen, i = [], set(), 0
    while True:
        i = s.find('{"model_name"', i)
        if i < 0:
            return out
        j = _match_brace(s, i)
        if j < 0:
            return out
        try:
            rec = json.loads(s[i:j])
        except Exception:
            i += 1
            continue
        mid = rec.get("model_id")
        if mid and mid not in seen:
            seen.add(mid)
            out.append(rec)
        i = j


def _match_brace(s: str, start: int) -> int:
    """Index just past the object opening at `start`, or -1."""
    depth, in_str, esc = 0, False, False
    for j in range(start, len(s)):
        c = s[j]
        if in_str:
            if esc:
                esc = False
            elif c == BACKSLASH:
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j + 1
    return -1
