// 문서를 공백 단위(어절)로 자른 뒤 겹치는 창으로 묶는다.
// 겹침 없이 자르면 "환불은 영업일 기준 3~5일" 같은 문장이
// 청크 경계에서 반으로 잘려 검색에 안 걸릴 수 있어서 overlap을 둔다.
export function chunkText(text: string, size = 200, overlap = 40): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  // 겹침이 크기 이상이면 step이 0 이하가 되어 start가 영영 안 늘어난다 —
  // 같은 청크를 무한히 밀어넣다 메모리가 터진다. 지금 부르는 곳은 기본값만
  // 쓰지만, 공개 함수의 인자를 "부르는 쪽이 알아서 맞추겠지"로 두지 않는다.
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + size).join(" "));
    if (start + size >= words.length) break;
  }
  return chunks;
}
