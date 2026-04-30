"""Split hair and mouth concept sheets into isolated single-item PNGs.

Each crop is saved into 3d_regen_sources/<category>/ with a trait-named filename
matching the suitboy_*_reference_manifest.json conventions. White padding is
added to make each crop square (Hunyuan input expectation).

Run:
    python split_sheets_for_hunyuan.py

After running, the new PNGs are listed and can be added to the overnight queue.
"""
import os
from PIL import Image, ImageDraw

HAIR_SHEETS_DIR = r"Z:/Islebound/assets/concepts/traits/hair/generated_sheets_from_real_refs"
MOUTH_SHEETS_DIR = r"Z:/Islebound/assets/concepts/traits/mouth/generated_sheets_from_real_refs"
OUT_HAIR = r"Z:/Islebound/assets/concepts/traits/3d_regen_sources/hair"
OUT_MOUTH = r"Z:/Islebound/assets/concepts/traits/3d_regen_sources/mouth"
os.makedirs(OUT_HAIR, exist_ok=True)
os.makedirs(OUT_MOUTH, exist_ok=True)


def crop_grid(sheet_path, out_dir, grid_cols, grid_rows, names, skip_cells=None):
    """Crop a sheet into grid items, save each as an isolated PNG.

    grid_cols x grid_rows defines the layout. names is a flat list in row-major
    order (TL, ..., TR, BL, ..., BR). skip_cells is a set of (col, row) indices
    to skip (e.g. empty cells).
    """
    skip_cells = skip_cells or set()
    im = Image.open(sheet_path).convert("RGB")
    w, h = im.size
    cell_w, cell_h = w // grid_cols, h // grid_rows
    name_iter = iter(names)
    saved = []
    for r in range(grid_rows):
        for c in range(grid_cols):
            if (c, r) in skip_cells:
                continue
            try:
                name = next(name_iter)
            except StopIteration:
                break
            box = (c * cell_w, r * cell_h, (c + 1) * cell_w, (r + 1) * cell_h)
            crop = im.crop(box)
            # ensure white background, no transparent
            bg = Image.new("RGB", crop.size, (255, 255, 255))
            bg.paste(crop)
            out_path = os.path.join(out_dir, name + ".png")
            bg.save(out_path)
            saved.append(out_path)
            print(f"  {name} -> {out_path}")
    return saved


print("=== Splitting hair sheets ===")

# batch_02: 2x2 grid 1254x1254
# Layout (per sheet view): TL=curly brown, TR=dreads black, BL=hide-eye white/ash, BR=long curls brown
crop_grid(
    os.path.join(HAIR_SHEETS_DIR, "hair_sheet_batch_02_curl_dreads_hideeye_longcurl.png"),
    OUT_HAIR, 2, 2,
    ["hair_curly_brown_rep", "hair_dread_black_rep",
     "hair_hide_eye_ash_rep", "hair_long_curls_brown_rep"]
)

# batch_03: 2x2 grid 1254x1254
# TL=mohican black, TR=pompadour black, BL=slicked back blond, BR=spiky black
crop_grid(
    os.path.join(HAIR_SHEETS_DIR, "hair_sheet_batch_03_mohican_pompadour_slickedback_spiky.png"),
    OUT_HAIR, 2, 2,
    ["hair_mohican_black_rep", "hair_pompadour_black_rep",
     "hair_slicked_back_blond_rep", "hair_spiky_black_rep"]
)

# batch_04: 2x2 grid 1254x1254
# TL=fedora long hair, TR=red beanie + bangs, BL=shaggy black, BR=side swept long
crop_grid(
    os.path.join(HAIR_SHEETS_DIR, "hair_sheet_batch_04_fedora_beanie_shaggy_side.png"),
    OUT_HAIR, 2, 2,
    ["hair_fedora_long_hair_rep", "hair_red_beanie_bangs_rep",
     "hair_shaggy_center_black_rep", "hair_side_swept_black_rep"]
)

# batch_05_corrected_v3: 1x3 grid 2172x724
# Cols: knight, nook, pepe
crop_grid(
    os.path.join(HAIR_SHEETS_DIR, "hair_sheet_batch_05_knight_nook_pepe_corrected_v3.png"),
    OUT_HAIR, 3, 1,
    ["hair_knight_helmet_v3crop", "hair_nook", "hair_pepe"]
)


print()
print("=== Splitting mouth sheets ===")

# mouth_batch_01: 1536x1024 = 3 cols x 2 rows, 5 items + 1 empty cell (BR)
# Per coverage JSON: Bandana, BlackMask, WhiteMask, WolfMask, JokerMask
# Visual order: TL=Bandana paisley, TC=BlackMask plain, TR=WhiteMask plain
# BL=WolfMask (cat-style mask), BC=JokerMask (red lips/teeth), BR=empty
crop_grid(
    os.path.join(MOUTH_SHEETS_DIR, "mouth_sheet_batch_01_masks_bandana_joker.png"),
    OUT_MOUTH, 3, 2,
    ["mouth_bandana", "mouth_blackmask", "mouth_whitemask",
     "mouth_wolfmask", "mouth_jokermask"],
    skip_cells={(2, 1)}
)

# mouth_batch_02: 1774x887 = 4 cols x 2 rows, 7 items + 1 empty cell (BR)
# Per coverage JSON: Basic, Bear, Bunny, Cat, Cow, Doge, Pepe
# Visual order: TL=Basic (tilde smile), TC1=Bear snout, TC2=Bunny, TR=Cat face
# BL=Cow (pacifier ring), BC=Doge, BC2=Pepe (red lips), BR=empty
crop_grid(
    os.path.join(MOUTH_SHEETS_DIR, "mouth_sheet_batch_02_basic_animal_pepe.png"),
    OUT_MOUTH, 4, 2,
    ["mouth_basic", "mouth_bear", "mouth_bunny", "mouth_cat",
     "mouth_cow", "mouth_doge", "mouth_pepe"],
    skip_cells={(3, 1)}
)


print()
print("=== Done ===")
print(f"Hair crops in: {OUT_HAIR}")
print(f"Mouth crops in: {OUT_MOUTH}")
