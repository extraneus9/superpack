// Which files the floating image viewer (viewer.html + viewer-page.js) opens.
import { extOf } from './util.js';

export const VIEWER_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff']);
export const isViewable = (it) => it && !it.d && VIEWER_EXT.has(extOf(it.n));
