#!/usr/bin/env python3
"""從 logo 原圖產生網站用的所有圖示（需要 Pillow：pip install pillow）。

    python tools/make-icons.py                    # 圖示
    python tools/make-icons.py og-screenshot.png  # 另外把分享預覽圖壓縮成 icons/og-image.png

原圖（不會部署成網站用的檔案，只是產生用的來源）：
    icons/src/logo-square.png  方形、不圓角的完整畫面（焦慮看盤小熊）
    icons/src/logo-mask.png    圓角外框的透明度遮罩，尺寸與上面相同

分享預覽圖：用瀏覽器開 tools/og.html，視窗設成 1200×630 截圖，再把截圖交給這支程式。

輸出一律轉成 256 色調色盤 PNG：畫風有顆粒質感，全彩 PNG 會大 8 倍左右。
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'icons'

square = Image.open(ICONS / 'src/logo-square.png').convert('RGB')
mask = Image.open(ICONS / 'src/logo-mask.png').convert('L')
S = max(square.size)  # 原圖約 1139×1125，拉成正方形（差 1%，看不出來）
square = square.resize((S, S), Image.LANCZOS)
rounded = square.convert('RGBA')
rounded.putalpha(mask.resize((S, S), Image.LANCZOS))


def save(img, name, size=None):
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    method = Image.Quantize.FASTOCTREE if img.mode == 'RGBA' else Image.Quantize.MEDIANCUT
    img.quantize(256, method=method).save(ICONS / name, optimize=True)
    print(f'{name:24} {(ICONS / name).stat().st_size // 1024:>4} KB')


# 有圓角、外面透明：分頁圖示、導覽列、安裝用圖示
save(rounded, 'favicon-32.png', 32)
save(rounded, 'logo-64.png', 64)          # 導覽列顯示 32px，2 倍解析度
save(rounded, 'icon-192.png', 192)
save(rounded, 'icon-512.png', 512)
# iOS 主畫面：不圓角、不透明，iOS 會自己切圓角
save(square, 'apple-touch-icon.png', 180)

# Android maskable：桌面可能切成圓形（直徑 80%），所以畫面縮到 76%，
# 上方補深藍、下方把桌面延伸到底，邊緣羽化接起來
k = 0.76
inner = square.resize((round(S * k),) * 2, Image.LANCZOS)
off = (S - inner.width) // 2
navy = inner.getpixel((inner.width // 2, 8))
desk = inner.getpixel((inner.width // 2, inner.height - 6))
desk_row = round(inner.height * 0.912)  # 原圖桌面上緣約在 91.2% 高
canvas = Image.new('RGB', (S, S), navy)
ImageDraw.Draw(canvas).rectangle((0, off + desk_row + 6, S, S), fill=desk)
feather = Image.new('L', inner.size, 0)
ImageDraw.Draw(feather).rectangle((24, 24, inner.width - 24, inner.height - 1), fill=255)
canvas.paste(inner, (off, off), feather.filter(ImageFilter.GaussianBlur(14)))
save(canvas, 'icon-maskable-512.png', 512)

if len(sys.argv) > 1:
    og = Image.open(sys.argv[1]).convert('RGB')
    if og.size != (1200, 630):
        sys.exit(f'og screenshot must be 1200x630, got {og.size}')
    save(og, 'og-image.png')
