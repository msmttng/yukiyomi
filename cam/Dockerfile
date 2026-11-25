# ユキヨミ ライブカメラ定時撮影（私用）— Cloud Run ジョブ用
FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY capture.mjs index.html ./
ENV TZ=Asia/Tokyo NODE_ENV=production
CMD ["node", "capture.mjs"]
