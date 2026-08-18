// 이미지 표시에 쓰는 공용 계산.
//
// 원래 realtime/Room.tsx 안에 있었는데, 문서 Q&A에도 이미지 첨부가 생기면서
// 두 화면이 같은 계산을 쓰게 됐다. 복사해두면 한쪽만 고친 버그가 생기는
// 종류의 코드라(하한·상한이 서로 얽힌 계산) 한 곳으로 뺐다.

// 이미지의 원본 크기를 미리 재둔다.
// 이 값이 있어야 <img>가 뜨기 전에 자리를 잡아, 사진이 로드될 때 위의 대화가
// 아래로 밀리지 않는다. 여기서 실패하면 브라우저가 못 읽는 파일이라는 뜻이라
// 업로드까지 가지 않고 바로 알려준다.
export async function readDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

// 말풍선에 넣을 이미지의 표시 크기.
//
// CSS만으로 width:100% / height:auto 를 주면 안 된다. 부모가 내용에 맞춰
// 줄어드는(shrink-to-fit) 상자라 100%의 기준이 결국 이미지의 원본 픽셀 크기가
// 되고, 넘겨준 width/height는 무시된다. 그러면 작은 이미지는 아주 작게 나오고,
// 무엇보다 로드되기 전에는 상자 크기를 모르니 자리를 못 잡아 대화가 밀린다.
// 그래서 표시 크기를 여기서 직접 계산해 상자에 박아둔다.
const MAX_W = 320;
const MAX_H = 360;
const MIN_SIDE = 48; // 아주 작은 이미지도 눌러볼 수 있을 만큼은 보이게

export function displaySize(width: number, height: number): { width: number; height: number } {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const base = Math.min(MAX_W / safeW, MAX_H / safeH, 1); // 원본보다 키우지는 않는다

  // 하한(MIN_SIDE)은 가로·세로에 따로 걸면 안 된다. 그러면 비율이 깨진 상자가
  // 나오고, 이미지는 object-fit: cover라 그만큼 잘려나간다 — 1000×10 배너가
  // 320×48 상자에 담겨 원본의 일부만 확대돼 보이는 식이다.
  // 그래서 하한도 비율을 유지한 채(양쪽 같은 배율로) 키우고,
  // 그러다 상한을 넘게 되면 키우기를 포기한다. 상자 모양이 원본과 다른 것보다
  // 작게 보이는 쪽이 낫다.
  const needed = Math.max(MIN_SIDE / (safeW * base), MIN_SIDE / (safeH * base), 1);
  const room = Math.max(Math.min(MAX_W / (safeW * base), MAX_H / (safeH * base)), 1);
  const scale = base * Math.min(needed, room);

  return {
    width: Math.round(safeW * scale),
    height: Math.round(safeH * scale),
  };
}
