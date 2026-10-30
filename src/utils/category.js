// File categories used by My Files, Search and the Storage dashboard.
export const CATEGORIES = ['photo', 'video', 'audio', 'pdf', 'doc', 'archive', 'other'];

export const CATEGORY_LABELS = {
  photo: { icon: '🖼', label: 'Photos' },
  video: { icon: '🎥', label: 'Videos' },
  audio: { icon: '🎵', label: 'Audio' },
  pdf: { icon: '📕', label: 'PDFs' },
  doc: { icon: '📄', label: 'Documents' },
  archive: { icon: '📦', label: 'Archives' },
  other: { icon: '📎', label: 'Other' },
};

const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']);
const DOC_EXT = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'tsv',
  'json', 'xml', 'html', 'htm', 'log', 'epub', 'pages', 'numbers', 'key',
]);

export const extensionOf = (name = '') => {
  const dot = String(name).lastIndexOf('.');
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase().slice(0, 10) : '';
};

export function categorize({ type = 'document', mime = '', name = '' } = {}) {
  const ext = extensionOf(name);
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type === 'photo' || mime.startsWith('image/')) return 'photo';
  if (['video', 'video_note', 'animation'].includes(type) || mime.startsWith('video/')) return 'video';
  if (['audio', 'voice'].includes(type) || mime.startsWith('audio/')) return 'audio';
  if (DOC_EXT.has(ext) || mime.startsWith('text/') || /officedocument|msword|ms-excel|ms-powerpoint/.test(mime)) return 'doc';
  return 'other';
}

export const isCategory = (value) => CATEGORIES.includes(value);

// Aliases accepted by the search "type:" filter.
const ALIASES = {
  photo: 'photo', photos: 'photo', image: 'photo', images: 'photo', img: 'photo', pic: 'photo',
  video: 'video', videos: 'video', movie: 'video',
  audio: 'audio', music: 'audio', voice: 'audio', sound: 'audio',
  pdf: 'pdf', pdfs: 'pdf',
  doc: 'doc', docs: 'doc', document: 'doc', documents: 'doc', office: 'doc',
  archive: 'archive', archives: 'archive', zip: 'archive', rar: 'archive',
  other: 'other',
};
export const categoryFromAlias = (word) => ALIASES[String(word).toLowerCase()] ?? null;
