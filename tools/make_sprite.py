# 把 codex 生成的大張像素精靈圖，轉成遊戲用的真正像素精靈圖
# 用法：python tools/make_sprite.py <原圖.png> <輸出.png> [--cols 4 --rows 2 --px 32]
#  1. 依欄列切格
#  2. 接近洋紅 #FF00FF 的像素當背景（透明）
#  3. 每格縮成 px×px：每個區塊取出現最多的顏色（不做平均，保持像素風銳利）
#  4. 每格以「腳底中心」對齊，避免生成時位置飄移造成動畫抖動
#  5. 輸出 RGBA 精靈圖，另外輸出放大預覽圖與 GIF 方便目視驗收
import argparse
from collections import Counter
from pathlib import Path
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--cols', type=int, default=4); ap.add_argument('--rows', type=int, default=2)
ap.add_argument('--px', type=int, default=32)
ap.add_argument('--colors', type=int, default=24, help='整組影格共用的色盤大小')
ap.add_argument('--key-dist', type=int, default=120, help='與洋紅的色差小於此值視為背景')
a = ap.parse_args()

src = Image.open(a.src).convert('RGB')
W, H = src.size
cw, ch = W / a.cols, H / a.rows
N = a.px

def is_bg(c):
    r, g, b = c
    # 洋紅：R、B 高，G 低；也吃掉邊緣混到洋紅的粉紫色
    return ((r - 255) ** 2 + g ** 2 + (b - 255) ** 2) ** 0.5 < a.key_dist or (r > 140 and b > 110 and b > g + 60)

def downsample(cell):
    w, h = cell.size
    px = cell.load()
    out = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    o = out.load()
    for j in range(N):
        for i in range(N):
            x0, x1 = int(i * w / N), int((i + 1) * w / N)
            y0, y1 = int(j * h / N), int((j + 1) * h / N)
            # 取區塊中央 60% 避開邊界混色
            mx, my = max(1, (x1 - x0) // 5), max(1, (y1 - y0) // 5)
            cnt = Counter()
            for y in range(y0 + my, y1 - my):
                for x in range(x0 + mx, x1 - mx):
                    c = px[x, y]
                    cnt['bg' if is_bg(c) else (c[0] // 8 * 8, c[1] // 8 * 8, c[2] // 8 * 8)] += 1
            top, n = cnt.most_common(1)[0]
            total = sum(cnt.values())
            if top == 'bg' and n > total * 0.5:
                continue
            fg = [(k, v) for k, v in cnt.most_common() if k != 'bg']
            if fg:
                o[i, j] = (*fg[0][0], 255)
    return out

frames = []
for r in range(a.rows):
    for c in range(a.cols):
        cell = src.crop((round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch)))
        frames.append(downsample(cell))

# 全部影格一起量化成同一組色盤，顏色才一致
strip = Image.new('RGBA', (N * len(frames), N))
for k, f in enumerate(frames):
    strip.paste(f, (k * N, 0))
alpha = strip.getchannel('A')
rgb = strip.convert('RGB')
opaque = [c for c, al in zip(rgb.get_flattened_data(), alpha.get_flattened_data()) if al]
dist2 = lambda p, q: sum((x - y) ** 2 for x, y in zip(p, q))

def median_cut(pixels, n):
    if not pixels:
        return []
    im = Image.new('RGB', (len(pixels), 1)); im.putdata(pixels)
    q = im.quantize(colors=n, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = q.getpalette()
    # 實際顏色比 n 少時，只取有用到的色盤索引
    used = sorted({i for i in q.get_flattened_data()})
    return [tuple(pal[i * 3:i * 3 + 3]) for i in used]

# median cut 會把面積小的重點色（例如綠色眼睛）併進大色塊；
# 跟主色盤差太多的像素另外分 ACCENT 個顏色保留下來
ACCENT = 4
palette = median_cut(opaque, a.colors - ACCENT)
outliers = [c for c in opaque if min(dist2(c, p) for p in palette) > 45 ** 2]
palette += median_cut(outliers, ACCENT)
cache = {}
def nearest(c):
    if c not in cache:
        cache[c] = min(palette, key=lambda p: dist2(c, p))
    return cache[c]
rgb.putdata([nearest(c) for c in rgb.get_flattened_data()])
strip = Image.merge('RGBA', (*rgb.split(), alpha))
frames = [strip.crop((k * N, 0, (k + 1) * N, N)) for k in range(len(frames))]

# 腳底中心對齊：每格的最下緣貼齊同一條線、水平置中
# 水平置中只看「身體」（整組出現最多的 3 個顏色），武器、弓、法杖伸出去時身體才不會左右跳
def bbox(f):
    return f.getchannel('A').getbbox()

body_colors = {c for c, _ in Counter(c for c in strip.get_flattened_data() if c[3]).most_common(3)}
def body_bbox(f):
    m = Image.new('L', f.size)
    m.putdata([255 if c in body_colors else 0 for c in f.get_flattened_data()])
    return m.getbbox() or bbox(f)

aligned = []
base_y = N - 2
for f in frames:
    bb = bbox(f)
    if not bb:
        aligned.append(f); continue
    l, t, rr, b = bb
    bl, _, br, _ = body_bbox(f)
    cx = (bl + br) / 2
    dx, dy = round(N / 2 - cx), base_y - b
    g = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    g.paste(f, (dx, dy))
    aligned.append(g)

sheet = Image.new('RGBA', (N * a.cols, N * a.rows), (0, 0, 0, 0))
for k, f in enumerate(aligned):
    sheet.paste(f, ((k % a.cols) * N, (k // a.cols) * N))
out = Path(a.out)
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out, optimize=True)

# 預覽：放大 8 倍、深色底（跟遊戲地圖同色）＋ 動畫 GIF
prev_dir = Path(a.src).parent
bgc = (19, 32, 66, 255)
big = Image.new('RGBA', sheet.size, bgc)
big.alpha_composite(sheet)
big.resize((sheet.width * 8, sheet.height * 8), Image.NEAREST).save(prev_dir / f'_preview_{out.stem}.png')
gif = []
for k, f in enumerate(aligned):
    g = Image.new('RGBA', (N, N), bgc); g.alpha_composite(f)
    gif.append(g.resize((N * 6, N * 6), Image.NEAREST).convert('P', palette=Image.ADAPTIVE))
gif[0].save(prev_dir / f'_preview_{out.stem}.gif', save_all=True, append_images=gif[1:], duration=160, loop=0)

colors = len({c for c in sheet.get_flattened_data() if c[3]})
print(f'{out}  {sheet.size}  {out.stat().st_size} bytes  {colors} 色  影格 bbox:', [bbox(f) for f in aligned])
