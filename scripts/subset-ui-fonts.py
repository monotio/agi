from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.varLib.instancer import instantiateVariableFont
from pathlib import Path
import argparse
import hashlib

# fonttools[woff]==4.66.1; upstream binaries are supplied by the maintainer.
parser = argparse.ArgumentParser(description="Build the bundled OFL UI font subsets.")
parser.add_argument(
    "sources",
    type=Path,
    help="Directory of the five upstream TTF files in CONTRIBUTING.md",
)
parser.add_argument("output", type=Path, help="Directory for the two WOFF2 subsets")
args = parser.parse_args()
base = args.sources
out = args.output
out.mkdir(parents=True, exist_ok=True)
identities = {
    "Geist[wght].ttf": "cdcc4815cbf5f9882fa74e48f8ab410a0495781a58ff7316570f664e7e987753",
    "GeistMono[wght].ttf": "0e1af3f507a1c8dfbb03d13ffad585834cd45ed7ccb78c756c7ce7873d180d30",
    "InterVariable.ttf": "4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf",
    "NotoSansMath-Regular.ttf": "3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d",
    "NotoSansSymbols2-Regular.ttf": "7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21",
}
for filename, digest in identities.items():
    if hashlib.sha256((base / filename).read_bytes()).hexdigest() != digest:
        raise ValueError(
            f"Unexpected upstream font: {filename}; review its source and licence before updating the identity."
        )
paths = {
    "geist": "Geist[wght].ttf",
    "geist-mono": "GeistMono[wght].ttf",
    "inter": "InterVariable.ttf",
}
text = "–—’“”…›⅛←↑→↓↖↗↘↙↵⇥⇧−≈≠⌃⌘⌥■▶○✓·↔↶↷⇄↩⇋⋯▸▾◂⚡⛓✦➜⠿"
chars = (
    set(range(0x20, 0x100))
    | {ord(c) for c in text}
    | {
        0x131,
        0x152,
        0x153,
        0x2BB,
        0x2BC,
        0x2C6,
        0x2DA,
        0x2DC,
        0x304,
        0x308,
        0x329,
        0xFEFF,
    }
)
donors = [
    TTFont(base / "NotoSansSymbols2-Regular.ttf"),
    TTFont(base / "NotoSansMath-Regular.ttf"),
    instantiateVariableFont(TTFont(base / paths["inter"]), {"wght": 400, "opsz": 14}),
]
for name in ["geist", "geist-mono"]:
    p = paths[name]
    f = TTFont(base / p, recalcTimestamp=False)
    if name == "geist":
        f["gvar"]
        f["HVAR"]
        for c in text:
            cp = ord(c)
            if cp in f.getBestCmap():
                continue
            donor = next(d for d in donors if cp in d.getBestCmap())
            glyph = donor.getBestCmap()[cp]
            gs = donor.getGlyphSet()
            record = DecomposingRecordingPen(gs)
            gs[glyph].draw(record)
            scale = f["head"].unitsPerEm / donor["head"].unitsPerEm
            pen = TTGlyphPen(None)
            record.replay(TransformPen(pen, (scale, 0, 0, scale, 0, 0)))
            gname = f"ui{cp:04X}"
            f["glyf"].glyphs[gname] = pen.glyph()
            f.setGlyphOrder(f.getGlyphOrder() + [gname])
            width, lsb = donor["hmtx"].metrics[glyph]
            f["hmtx"].metrics[gname] = (round(width * scale), round(lsb * scale))
            f["gvar"].variations[gname] = []
            # Geist uses an explicit advance map. Added symbols have no weight deltas.
            store = f["HVAR"].table.VarStore
            zero = next(
                (
                    i << 16 | j
                    for i, d in enumerate(store.VarData)
                    for j, item in enumerate(d.Item)
                    if not any(item)
                ),
                None,
            )
            if zero is None:
                d = store.VarData[0]
                zero = len(d.Item)
                d.Item.append([0] * d.VarRegionCount)
                d.ItemCount = len(d.Item)
            f["HVAR"].table.AdvWidthMap.mapping[gname] = zero
            for cm in f["cmap"].tables:
                if cm.isUnicode() and cm.format in [4, 12]:
                    cm.cmap[cp] = gname
        family = "AGI Geist"
        for nid, value in [
            (1, family),
            (4, family + " Regular"),
            (6, family.replace(" ", "") + "-Regular"),
            (16, family),
            (3, family + " UI subset"),
        ]:
            for rec in f["name"].names:
                if rec.nameID == nid:
                    rec.string = value.encode(rec.getEncoding())
        copyrights = "Copyright 2024 The Geist Project Authors; Copyright 2016 The Inter Project Authors; Copyright 2022 The Noto Project Authors"
        f["name"].setName(copyrights, 0, 3, 1, 0x409)
    o = subset.Options()
    o.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    o.name_legacy = True
    o.name_languages = [0x409]
    s = subset.Subsetter(options=o)
    s.populate(unicodes=chars)
    s.subset(f)
    f.flavor = "woff2"
    filename = out / (name + "-latin.woff2")
    f.save(filename)
    digest = hashlib.sha256(filename.read_bytes()).hexdigest()[:8]
    prefix = "agi-geist-latin" if name == "geist" else "geist-mono-latin"
    dest = out / (prefix + "-" + digest + ".woff2")
    filename.rename(dest)
    print(dest.name, dest.stat().st_size)
