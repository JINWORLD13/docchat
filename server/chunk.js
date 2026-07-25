// 문서를 공백 단위(어절)로 자른 뒤 겹치는 창으로 묶는다.
// 겹침 없이 자르면 "환불은 영업일 기준 3~5일" 같은 문장이
// 청크 경계에서 반으로 잘려 검색에 안 걸릴 수 있어서 overlap을 둔다.
export function chunkText(text, size = 200, overlap = 40) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks = [];
  const step = size - overlap;
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + size).join(" "));
    if (start + size >= words.length) break;
  }
  return chunks;
}
