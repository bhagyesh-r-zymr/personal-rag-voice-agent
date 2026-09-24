export function chunkText(text, { size = 350, overlap = 60 } = {}) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];

  if (!words.length) return chunks;

  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + size, words.length);
    const content = words.slice(start, end).join(' ');
    chunks.push(content);
    if (end === words.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
