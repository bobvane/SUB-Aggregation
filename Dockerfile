# ---------- 构建阶段：装依赖、生成内联 HTML、跑测试、打成单文件 ----------
FROM node:25-alpine AS build
WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 生成 src/html.js（前端内联产物）并跑全量测试 —— 测试不通过就不出镜像
RUN npm run build:html && npm test

# 打成单文件：运行镜像里不需要 node_modules
RUN npm run build:server

# ---------- 运行阶段：只有 node 和一个 server.mjs ----------
FROM node:25-alpine
WORKDIR /app

COPY --from=build /app/dist/server.mjs ./server.mjs

ENV PORT=20130 \
    DB_PATH=/data/app.db \
    NODE_ENV=production

VOLUME /data
EXPOSE 20130

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:20130/ || exit 1

CMD ["node", "server.mjs"]
