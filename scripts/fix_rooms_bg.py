# -*- coding: utf-8 -*-
from PIL import Image
im = Image.open(r"scripts\assets-backup\rooms-bg.png").convert("RGB")
if im.width > 750:
    im = im.resize((750, int(im.height * 750 / im.width)), Image.LANCZOS)
im.save(r"miniprogram\assets\icons\rooms-bg.jpg", quality=55, optimize=True)
import os
print("rooms-bg.jpg:", os.path.getsize(r"miniprogram\assets\icons\rooms-bg.jpg") // 1024, "KB", im.size)
