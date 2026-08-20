import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from './config.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
    this.status = 400;
  }
}

/**
 * 前端送來的是 data URL（相機拍照或選檔後在瀏覽器縮圖過）。
 * 這裡驗證格式與大小，轉成 Messages API 的 image block。
 */
export function toImageBlocks(images) {
  if (!images) return [];
  if (!Array.isArray(images)) throw new ImageError('images 必須是陣列');
  if (images.length > MAX_IMAGES_PER_TURN) {
    throw new ImageError(`一次最多 ${MAX_IMAGES_PER_TURN} 張圖片`);
  }

  return images.map((raw, i) => {
    const dataUrl = typeof raw === 'string' ? raw : raw?.dataUrl;
    if (typeof dataUrl !== 'string') throw new ImageError(`第 ${i + 1} 張圖片格式不正確`);

    const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(dataUrl.trim());
    if (!match) throw new ImageError(`第 ${i + 1} 張圖片必須是 base64 的 data URL`);

    const mediaType = match[1].toLowerCase();
    if (!ALLOWED.has(mediaType)) {
      throw new ImageError(`不支援的圖片格式 ${mediaType}（僅支援 JPEG / PNG / GIF / WebP）`);
    }

    const data = match[2].replace(/\s/g, '');
    const bytes = Math.floor((data.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      const mb = (MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1);
      throw new ImageError(`第 ${i + 1} 張圖片超過 ${mb}MB，請先縮圖`);
    }

    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
}
