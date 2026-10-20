# 從影格挑 4 張，清成純洋紅底，拼成 4 欄 x 1 列
import sys
from PIL import Image
out=sys.argv[1]; box=tuple(map(int,sys.argv[2].split(','))); files=sys.argv[3:]
cells=[]
for f in files:
    im=Image.open(f).convert('RGB').crop(box)
    d=im.load(); n=0
    for y in range(im.height):
        for x in range(im.width):
            r,g,b=d[x,y]
            if r>140 and b>110 and b>g+60: d[x,y]=(255,0,255)
    cells.append(im)
w,h=cells[0].size
S=Image.new('RGB',(w*len(cells),h),(255,0,255))
for i,c in enumerate(cells): S.paste(c,(i*w,0))
S.save(out); print(out,S.size)
