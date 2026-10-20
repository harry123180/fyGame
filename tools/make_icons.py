# 產生 PWA 圖示：深藍底、三顆彩色球（maskable 版本內容縮在安全區內）
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
def icon(size, safe):
    s = 4  # 超取樣抗鋸齒
    S = size * s
    img = Image.new('RGB', (S, S), '#0f172a')
    d = ImageDraw.Draw(img)
    k = S * safe
    o = (S - k) / 2
    for cx, cy, r, c in [(0.36, 0.40, 0.17, '#facc15'), (0.66, 0.36, 0.13, '#38bdf8'), (0.55, 0.68, 0.15, '#f472b6')]:
        x, y, rr = o + cx * k, o + cy * k, r * k
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=c, outline='white', width=max(1, int(k * 0.018)))
    return img.resize((size, size), Image.LANCZOS)

icon(192, 1.0).save(f'{out}/icon-192.png')
icon(512, 1.0).save(f'{out}/icon-512.png')
icon(512, 0.75).save(f'{out}/icon-maskable-512.png')
icon(180, 0.9).save(f'{out}/apple-touch-icon.png')
