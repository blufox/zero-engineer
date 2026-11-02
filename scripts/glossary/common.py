"""Shared helpers. Run each generator from this folder: `python3 patterns.py` etc.
The generated JSON in src/seed/glossary/ is what ships with the app."""
import json, textwrap
from pathlib import Path

OUT = str(Path(__file__).resolve().parents[2] / "src" / "seed" / "glossary") + "/"
def code(s): return textwrap.dedent(s).strip("\n")
def ex(php=None, python=None, dart=None):
    out = []
    for lang, c in (("php", php), ("python", python), ("dart", dart)):
        if c: out.append({"language": lang, "code": code(c)})
    return out
def write(name, collection):
    ids = [e["id"] for e in collection["entries"]]
    assert len(ids) == len(set(ids)), "duplicate ids"
    json.dump(collection, open(OUT + name + ".json", "w"), indent=2, ensure_ascii=False)
    print(name, len(ids), "entries")
