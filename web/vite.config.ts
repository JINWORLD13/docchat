import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 문서 Q&A REST + SSE
      "/api": "http://localhost:4000",
      // 실시간 채팅. ws:true를 빼면 처음 polling 핸드셰이크만 되고
      // WebSocket 업그레이드에서 조용히 실패해 계속 polling으로 돈다.
      "/socket.io": { target: "http://localhost:4000", ws: true },
    },
  },
});
