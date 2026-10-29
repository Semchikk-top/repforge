/** Уменьшает фото до maxSide пикселей по большей стороне и возвращает JPEG в виде data-URL (EXIF-поворот учитывает браузер) */
export async function resizeImage(file: Blob, maxSide: number, quality: number): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать фото');
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally { bmp.close(); }
}
