import json, math
W, H = 2400, 1600
CX, CY = 1200, 800
OUT = r"C:\Users\user\Desktop\fyGaming\assets-src\maps\stages.json"

SPAWNS = [dict(x=40, y=40, w=320, h=260), dict(x=2040, y=40, w=320, h=260),
          dict(x=40, y=1300, w=320, h=260), dict(x=2040, y=1300, w=320, h=260)]

def ob(x, y, r, kind=None):
    kind = kind or ('big' if r >= 45 else 'mid')
    return dict(x=int(round(x)), y=int(round(y)), r=r, kind=kind)

def te(x, y, rx, ry, t):
    return dict(x=int(round(x)), y=int(round(y)), rx=rx, ry=ry, type=t)

def pu(x, y):
    return dict(x=int(round(x)), y=int(round(y)))

def m4(fn, x, y, *a):  # 四象限鏡射
    return [fn(x, y, *a), fn(W - x, y, *a), fn(x, H - y, *a), fn(W - x, H - y, *a)]

def mx(fn, x, y, *a):
    return [fn(x, y, *a), fn(W - x, y, *a)]

def my(fn, x, y, *a):
    return [fn(x, y, *a), fn(x, H - y, *a)]

def polar(rx, ry, deg):
    a = math.radians(deg)
    return CX + rx * math.cos(a), CY + ry * math.sin(a)

stages = []

# 1 草原：不對稱散落的樹叢，泥沼蓋在四條對角捷徑上
stages.append(dict(id='meadow', name='草原', spawns=SPAWNS,
    obstacles=[ob(560, 560, 58), ob(880, 300, 62), ob(420, 430, 30),
               ob(1840, 520, 60), ob(1500, 260, 55), ob(2020, 430, 32),
               ob(600, 1060, 62), ob(900, 1330, 56), ob(380, 1180, 30),
               ob(1820, 1080, 58), ob(1530, 1330, 62), ob(2030, 1170, 32),
               ob(1200, 200, 36), ob(1200, 1400, 36), ob(240, 800, 50), ob(2160, 800, 50)],
    terrain=m4(te, 720, 470, 140, 95, 'mud'),
    powerups=[pu(650, 170), pu(1760, 160), pu(640, 1440), pu(1760, 1450),
              pu(1200, 80), pu(1200, 1520), pu(720, 800), pu(1680, 800),
              pu(1050, 360), pu(1350, 1240)]))

# 2 村莊：8 間小木屋圍著中央廣場排成一圈，屋與屋之間是巷子；池塘在村子左右兩側邊緣
houses = [ob(*polar(640, 520, 22.5 + 45 * k), 62 if k % 2 else 66, 'big') for k in range(8)]
stages.append(dict(id='village', name='村莊', spawns=SPAWNS,
    obstacles=houses + [ob(1200, 150, 34), ob(1200, 1450, 34), ob(560, 230, 30), ob(1840, 1370, 30)],
    terrain=[te(230, 800, 170, 220, 'pond'), te(2170, 800, 170, 220, 'pond'),
             te(1560, 1470, 220, 100, 'pond')],
    powerups=[pu(560, 800), pu(1840, 800), pu(1200, 300), pu(1200, 1300),
              pu(820, 140), pu(1580, 140), pu(820, 1460), pu(1600, 1330),
              pu(470, 1060), pu(1930, 540)]))

# 3 城市：大樓街區排成棋盤，十字大道上鋪加速輸送帶，路口放路障當臨時掩體
city_obs = []
for x in (560, 900, 1500, 1840):
    for y in (330, 1270):
        city_obs.append(ob(x, y, 70, 'big'))
city_obs += m4(ob, 760, 570, 30) + [ob(330, 560, 58, 'big'), ob(2070, 1040, 58, 'big')]
stages.append(dict(id='city', name='城市', spawns=SPAWNS,
    obstacles=city_obs,
    terrain=[te(470, 800, 250, 80, 'conveyor'), te(1930, 800, 250, 80, 'conveyor'),
             te(1200, 270, 80, 210, 'conveyor'), te(1200, 1330, 80, 210, 'conveyor')],
    powerups=[pu(730, 130), pu(1670, 130), pu(730, 1470), pu(1670, 1470),
              pu(140, 800), pu(2260, 800), pu(1060, 390), pu(1340, 1210),
              pu(560, 1000), pu(1840, 600)]))

# 4 沙漠：四道砂岩牆夾出上、中、下三條東西向走廊，流沙堵在最近的入口
desert_obs = []
for x in (520, 650, 780):
    desert_obs += m4(ob, x, 520, 64, 'big')
desert_obs += m4(ob, 920, 300, 34)
stages.append(dict(id='desert', name='沙漠', spawns=SPAWNS,
    obstacles=desert_obs,
    terrain=[te(1200, 300, 230, 110, 'quicksand'), te(1200, 1300, 230, 110, 'quicksand'),
             te(290, 800, 170, 150, 'quicksand'), te(2110, 800, 170, 150, 'quicksand')],
    powerups=[pu(650, 300), pu(1750, 300), pu(650, 1300), pu(1750, 1300),
              pu(650, 800), pu(1750, 800), pu(1200, 90), pu(1200, 1510),
              pu(80, 520), pu(2320, 1080)]))

# 5 海灘：整個下緣是海，椰子樹散在沙灘上，礁岩沿著海岸線
stages.append(dict(id='beach', name='海灘', spawns=SPAWNS,
    obstacles=[ob(520, 520, 56), ob(860, 290, 58), ob(1560, 300, 55), ob(1900, 500, 58),
               ob(1200, 170, 50), ob(330, 940, 52), ob(2070, 930, 52),
               ob(600, 1250, 34), ob(1020, 1290, 30), ob(1390, 1290, 32), ob(1800, 1250, 34)],
    terrain=[te(700, 1600, 260, 230, 'sea'), te(1200, 1600, 260, 250, 'sea'),
             te(1700, 1600, 260, 230, 'sea'), te(2230, 1080, 130, 100, 'sea')],
    powerups=[pu(640, 160), pu(1760, 160), pu(330, 700), pu(2070, 700),
              pu(780, 1280), pu(1620, 1280), pu(1200, 1300), pu(1000, 420),
              pu(1440, 450), pu(1200, 1520)]))

# 6 雪原：左右與上下四片大冰湖直通擂台，四角是雪松林
snow_obs = m4(ob, 470, 520, 58, 'big') + m4(ob, 790, 320, 62, 'big') + m4(ob, 720, 560, 34, 'mid')
stages.append(dict(id='snow', name='雪原', spawns=SPAWNS,
    obstacles=snow_obs,
    terrain=[te(520, 800, 250, 180, 'ice'), te(1880, 800, 250, 180, 'ice'),
             te(1200, 230, 260, 130, 'ice'), te(1200, 1370, 260, 130, 'ice')],
    powerups=[pu(150, 800), pu(2250, 800), pu(1200, 70), pu(1200, 1530),
              pu(600, 160), pu(1800, 1440), pu(600, 1440), pu(1800, 160),
              pu(930, 440), pu(1470, 1160)]))

# 7 火山：左右兩條熔岩河，只在中段留一座橋，橋頭有黑曜石；河的上下兩端可繞
lava_obs = mx(ob, 720, 650, 52, 'big') + mx(ob, 720, 950, 52, 'big') + m4(ob, 1000, 250, 34) \
    + [ob(1200, 130, 60), ob(1200, 1470, 60), ob(260, 600, 50), ob(2140, 1000, 50)]
stages.append(dict(id='lava', name='火山', spawns=SPAWNS,
    obstacles=lava_obs,
    terrain=mx(te, 520, 440, 100, 210, 'lava') + mx(te, 520, 1160, 100, 210, 'lava'),
    powerups=[pu(520, 800), pu(1880, 800), pu(520, 100), pu(1880, 1500),
              pu(160, 1000), pu(2240, 600), pu(1200, 330), pu(1200, 1270),
              pu(760, 800), pu(1640, 800)]))

# 8 天空神殿：內圈 8 根石柱、外圈斜角 4 顆浮空水晶，十字星光氣流穿過柱間直達中央
pillars = [ob(*polar(500, 500, 22.5 + 45 * k), 32, 'mid') for k in range(8)]
crystals = [ob(*polar(820, 560, 45 + 90 * k), 60, 'big') for k in range(4)]
outer = [ob(*polar(1000, 700, a), 30, 'mid') for a in (0, 180)]
stages.append(dict(id='sky', name='天空神殿', spawns=SPAWNS,
    obstacles=pillars + crystals + outer,
    terrain=[te(600, 800, 250, 80, 'starwind'), te(1800, 800, 250, 80, 'starwind'),
             te(1200, 310, 80, 230, 'starwind'), te(1200, 1290, 80, 230, 'starwind')],
    powerups=[pu(380, 800), pu(2020, 800), pu(1200, 90), pu(1200, 1510),
              pu(800, 160), pu(1600, 1440), pu(800, 1440), pu(1600, 160),
              pu(940, 420), pu(1460, 1180)]))

json.dump(dict(width=W, height=H, stages=stages), open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('wrote', OUT)
