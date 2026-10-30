import { config } from '../config.js';

export const deepLink = (token) => `https://t.me/${config.botUsername}?start=f_${token}`;
export const shareLink = deepLink; // everything happens inside Telegram
export const telegramShareUrl = (link) =>
  `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('📎 A file was shared with you')}`;
export const telegramShareDeepUrl = (token) => telegramShareUrl(deepLink(token));
export const whatsappShareUrl = (link) =>
  `https://wa.me/?text=${encodeURIComponent(`📎 A file was shared with you:\n${link}`)}`;

// ---- file collections -------------------------------------------------------------------------
// The public link of a collection is a web page (needs a public https BASE_URL / RAILWAY_PUBLIC_DOMAIN).
// Without one (e.g. local development) it falls back to a Telegram deep link that delivers the files in chat.
export const collectionDeepLink = (token, fileRef = '') => `https://t.me/${config.botUsername}?start=c_${token}${fileRef ? `_${fileRef}` : ''}`;
export const hasWebLinks = () => config.baseUrl.startsWith('https://');
export const collectionLink = (token) => (hasWebLinks() ? `${config.baseUrl}/share/${token}` : collectionDeepLink(token));
export const collectionShareUrl = (link) =>
  `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('📁 A file collection was shared with you')}`;
