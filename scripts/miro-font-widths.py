# Regenerates electron/miro-font-widths.json: Segoe UI advance widths (1/1000 em)
# that the Miro importer uses to size text boxes. Needs Pillow and Windows fonts.
import json, pathlib
from PIL import ImageFont
ranges = [(32, 592), (0x370, 0x400), (0x400, 0x530), (0x2000, 0x2070), (0x2190, 0x2200), (0x2500, 0x2580)]
out = {}
for name, file in (('regular', 'segoeui.ttf'), ('bold', 'segoeuib.ttf')):
    font = ImageFont.truetype('C:/Windows/Fonts/' + file, 1000)
    out[name] = [[a, [round(font.getlength(chr(c))) for c in range(a, b)]] for a, b in ranges]
path = pathlib.Path(__file__).resolve().parent.parent / 'electron' / 'miro-font-widths.json'
path.write_text(json.dumps(out, separators=(',', ':')))
print(path, path.stat().st_size)
