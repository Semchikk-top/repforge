"""QR-код как SVG (без Pillow): сервер отдаёт готовую картинку, клиенту не нужна библиотека."""
from __future__ import annotations

import io

import qrcode
import qrcode.image.svg


def svg(text: str) -> str:
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2,
                      error_correction=qrcode.constants.ERROR_CORRECT_M)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")
