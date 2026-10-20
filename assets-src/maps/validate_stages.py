"""驗證 stages.json 並輸出每關俯視預覽圖 _preview_<id>.png。

用法：python validate_stages.py
檢查項目（每關）：
 1. 中央半徑 420 內沒有障礙物
 2. 出生區內沒有障礙物和熔岩
 3. 20px 格子 BFS（障礙物膨脹 60）：四個出生區都走得到中央
    3b. 每個出生區至少 3 條彼此分開的通道（貪婪法：找到一條就把路線兩側 100px 封掉再找）
    3c. 把熔岩當牆也走得到（熔岩不在必經之路上）
 4. 道具點不在障礙物／熔岩裡、離障礙物邊緣 >= 60、在中央擂台外
 5. 數量：障礙物 10~16、地形 3~6、道具 8~12；尺寸合乎規格；熔岩邊緣離擂台 >= 80
"""
import json, math, os, sys
from collections import deque
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
CX, CY = 1200, 800
ARENA = 420
CELL = 20
INFLATE = 60
PLAYER_R = 22
ORDER = ['meadow', 'village', 'city', 'desert', 'beach', 'snow', 'lava', 'sky']
TYPES = {'meadow': 'mud', 'village': 'pond', 'city': 'conveyor', 'desert': 'quicksand',
         'beach': 'sea', 'snow': 'ice', 'lava': 'lava', 'sky': 'starwind'}

BG = {'meadow': (96, 160, 72), 'village': (150, 140, 96), 'city': (90, 92, 100), 'desert': (222, 196, 140),
      'beach': (238, 220, 170), 'snow': (232, 240, 248), 'lava': (52, 44, 44), 'sky': (205, 215, 240)}
TCOL = {'mud': (110, 80, 50), 'pond': (80, 140, 200), 'conveyor': (240, 150, 40), 'quicksand': (190, 150, 80),
        'sea': (40, 110, 200), 'ice': (150, 210, 240), 'lava': (240, 80, 20), 'starwind': (250, 230, 120)}


def in_ellipse(px, py, t, pad=0):
    rx, ry = t['rx'] + pad, t['ry'] + pad
    return ((px - t['x']) / rx) ** 2 + ((py - t['y']) / ry) ** 2 <= 1


def ellipse_min_dist(t, px, py):
    return min(math.hypot(t['x'] + t['rx'] * math.cos(a) - px, t['y'] + t['ry'] * math.sin(a) - py)
               for a in (i * math.pi / 360 for i in range(720)))


def circle_rect_dist(o, s):
    nx = min(max(o['x'], s['x']), s['x'] + s['w'])
    ny = min(max(o['y'], s['y']), s['y'] + s['h'])
    return math.hypot(o['x'] - nx, o['y'] - ny)


def ellipse_hits_rect(t, s):
    for i in range(0, s['w'] + 1, 10):
        for j in range(0, s['h'] + 1, 10):
            if in_ellipse(s['x'] + i, s['y'] + j, t):
                return True
    return False


def build_grid(st, W, H, lava_block):
    gw, gh = W // CELL, H // CELL
    blocked = [[False] * gw for _ in range(gh)]
    for gy in range(gh):
        for gx in range(gw):
            px, py = gx * CELL + CELL / 2, gy * CELL + CELL / 2
            if px < PLAYER_R or py < PLAYER_R or px > W - PLAYER_R or py > H - PLAYER_R:
                blocked[gy][gx] = True
                continue
            for o in st['obstacles']:
                if math.hypot(px - o['x'], py - o['y']) < o['r'] + INFLATE:
                    blocked[gy][gx] = True
                    break
            else:
                if lava_block:
                    for t in st['terrain']:
                        if t['type'] == 'lava' and in_ellipse(px, py, t, PLAYER_R):
                            blocked[gy][gx] = True
                            break
    return blocked


def spawn_cells(s, blocked):
    out = []
    for gy in range(len(blocked)):
        for gx in range(len(blocked[0])):
            px, py = gx * CELL + CELL / 2, gy * CELL + CELL / 2
            if s['x'] <= px <= s['x'] + s['w'] and s['y'] <= py <= s['y'] + s['h'] and not blocked[gy][gx]:
                out.append((gx, gy))
    return out


def is_goal(gx, gy):
    return math.hypot(gx * CELL + CELL / 2 - CX, gy * CELL + CELL / 2 - CY) <= 200


def bfs(starts, blocked, extra=None):
    gh, gw = len(blocked), len(blocked[0])
    prev = {c: None for c in starts}
    q = deque(starts)
    while q:
        c = q.popleft()
        if is_goal(*c):
            path = []
            while c is not None:
                path.append(c)
                c = prev[c]
            return path[::-1]
        x, y = c
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if 0 <= n[0] < gw and 0 <= n[1] < gh and n not in prev and not blocked[n[1]][n[0]] \
                    and (extra is None or n not in extra):
                prev[n] = c
                q.append(n)
    return None


def count_channels(starts, blocked, s, want=3, sep=100):
    """貪婪找互相分開的路線：每找到一條就把路線周圍 sep px 封掉（出生區附近與擂台內不封）。"""
    extra = set()
    k = 0
    rad = sep // CELL
    for _ in range(want):
        path = bfs(starts, blocked, extra)
        if not path:
            break
        k += 1
        for (x, y) in path:
            px, py = x * CELL + CELL / 2, y * CELL + CELL / 2
            if math.hypot(px - CX, py - CY) < ARENA + 60:
                continue
            near_spawn = (s['x'] - 120 <= px <= s['x'] + s['w'] + 120 and s['y'] - 120 <= py <= s['y'] + s['h'] + 120)
            if near_spawn:
                continue
            for dx in range(-rad, rad + 1):
                for dy in range(-rad, rad + 1):
                    if dx * dx + dy * dy <= rad * rad:
                        extra.add((x + dx, y + dy))
    return k


def draw_preview(st, W, H, path):
    S = 0.4
    img = Image.new('RGB', (int(W * S), int(H * S)), BG[st['id']])
    d = ImageDraw.Draw(img, 'RGBA')
    for t in st['terrain']:
        c = TCOL[t['type']]
        d.ellipse([(t['x'] - t['rx']) * S, (t['y'] - t['ry']) * S, (t['x'] + t['rx']) * S, (t['y'] + t['ry']) * S],
                  fill=c + (190,), outline=c)
    for s in st['spawns']:
        d.rectangle([s['x'] * S, s['y'] * S, (s['x'] + s['w']) * S, (s['y'] + s['h']) * S], outline=(30, 200, 255), width=3)
    for i in range(0, 360, 8):  # 擂台虛線
        a0, a1 = math.radians(i), math.radians(i + 4)
        d.line([(CX + ARENA * math.cos(a0)) * S, (CY + ARENA * math.sin(a0)) * S,
                (CX + ARENA * math.cos(a1)) * S, (CY + ARENA * math.sin(a1)) * S], fill=(255, 60, 60), width=2)
    d.ellipse([(CX - 60) * S, (CY - 60) * S, (CX + 60) * S, (CY + 60) * S], fill=(200, 40, 40))
    for o in st['obstacles']:
        g = (110, 110, 110) if o['kind'] == 'big' else (160, 160, 160)
        d.ellipse([(o['x'] - o['r']) * S, (o['y'] - o['r']) * S, (o['x'] + o['r']) * S, (o['y'] + o['r']) * S],
                  fill=g, outline=(40, 40, 40), width=2)
    for p in st['powerups']:
        d.ellipse([(p['x'] - 18) * S, (p['y'] - 18) * S, (p['x'] + 18) * S, (p['y'] + 18) * S],
                  fill=(255, 220, 0), outline=(0, 0, 0))
    d.text((8, 6), f"{st['id']} {len(st['obstacles'])} obs / {len(st['terrain'])} terrain / {len(st['powerups'])} pu",
           fill=(0, 0, 0) if st['id'] not in ('lava', 'city') else (255, 255, 255))
    img.save(path)


def check_stage(st, W, H):
    res = {}
    obs, ter, pus = st['obstacles'], st['terrain'], st['powerups']
    lavas = [t for t in ter if t['type'] == 'lava']

    bad = [o for o in obs if math.hypot(o['x'] - CX, o['y'] - CY) - o['r'] < ARENA]
    res['1 中央淨空'] = (not bad, f'{len(bad)} 個障礙物侵入' if bad else '')

    bad = []
    for s in st['spawns']:
        bad += [('obs', o['x'], o['y']) for o in obs if circle_rect_dist(o, s) < o['r']]
        bad += [('lava', t['x'], t['y']) for t in lavas if ellipse_hits_rect(t, s)]
    res['2 出生區乾淨'] = (not bad, str(bad) if bad else '')

    blocked = build_grid(st, W, H, False)
    blocked_lava = build_grid(st, W, H, True)
    reach, chans, lava_ok = [], [], []
    for s in st['spawns']:
        starts = spawn_cells(s, blocked)
        reach.append(bool(starts) and bfs(starts, blocked) is not None)
        chans.append(count_channels(starts, blocked, s) if starts else 0)
        st2 = spawn_cells(s, blocked_lava)
        lava_ok.append(bool(st2) and bfs(st2, blocked_lava) is not None)
    res['3 出生區可達中央'] = (all(reach), str(reach))
    res['3b 每區 >=3 條分開的通道'] = (all(c >= 3 for c in chans), f'通道數 {chans}')
    res['3c 繞開熔岩也到得了'] = (all(lava_ok), str(lava_ok))

    bad = []
    for p in pus:
        dmin = min(math.hypot(p['x'] - o['x'], p['y'] - o['y']) - o['r'] for o in obs)
        if dmin < 60:
            bad.append((p['x'], p['y'], f'離障礙物 {dmin:.0f}'))
        if any(in_ellipse(p['x'], p['y'], t, 18) for t in lavas):
            bad.append((p['x'], p['y'], '在熔岩裡'))
        if math.hypot(p['x'] - CX, p['y'] - CY) < ARENA:
            bad.append((p['x'], p['y'], '在擂台內'))
        if not (18 <= p['x'] <= W - 18 and 18 <= p['y'] <= H - 18):
            bad.append((p['x'], p['y'], '出界'))
    res['4 道具點位置'] = (not bad, str(bad) if bad else '')

    msgs = []
    if not 10 <= len(obs) <= 16: msgs.append(f'障礙物 {len(obs)}')
    if not 3 <= len(ter) <= 6: msgs.append(f'地形 {len(ter)}')
    if not 8 <= len(pus) <= 12: msgs.append(f'道具 {len(pus)}')
    for o in obs:
        lo, hi = (45, 70) if o['kind'] == 'big' else (25, 40)
        if not lo <= o['r'] <= hi: msgs.append(f"{o['kind']} r={o['r']}")
    for t in ter:
        if not (80 <= t['rx'] <= 260 and 80 <= t['ry'] <= 260): msgs.append(f"terrain rx/ry {t['rx']},{t['ry']}")
    main = TYPES[st['id']]
    if sum(t['type'] == main for t in ter) < len(ter) / 2: msgs.append('主題地形不是多數')
    for t in lavas:
        dd = ellipse_min_dist(t, CX, CY) if not in_ellipse(CX, CY, t) else 0
        if dd < ARENA + 80: msgs.append(f"熔岩邊緣離中央 {dd:.0f} < 500")
    res['5 數量與尺寸'] = (not msgs, '; '.join(msgs))
    return res


def main():
    data = json.load(open(os.path.join(HERE, 'stages.json'), encoding='utf-8'))
    W, H = data['width'], data['height']
    ids = [s['id'] for s in data['stages']]
    allok = ids == ORDER
    print('關卡順序', ids, 'OK' if allok else f'應為 {ORDER}')
    for st in data['stages']:
        res = check_stage(st, W, H)
        print(f"\n== {st['id']} {st['name']}：障礙物 {len(st['obstacles'])}"
              f"（big {sum(o['kind']=='big' for o in st['obstacles'])}／mid {sum(o['kind']=='mid' for o in st['obstacles'])}）"
              f"、地形 {len(st['terrain'])}、道具 {len(st['powerups'])}")
        for k, (ok, msg) in res.items():
            allok &= ok
            print(f"  [{'PASS' if ok else 'FAIL'}] {k} {msg}")
        draw_preview(st, W, H, os.path.join(HERE, f"_preview_{st['id']}.png"))
    print('\n全部通過' if allok else '\n有項目未通過')
    sys.exit(0 if allok else 1)


if __name__ == '__main__':
    main()
