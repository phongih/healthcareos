# syntax=docker/dockerfile:1.7
# HealthcareOS API — multi-stage, non-root, không chứa bí mật.
# Build (context = thư mục gốc repo):  docker build -f services/api/Dockerfile -t hcos-api:local .
# Yêu cầu: package-lock.json đã commit (npm ci sẽ thất bại nếu thiếu/lệch => build có thể tái lập).
# Lưu ý: nên ghim base image theo digest (node:22-bookworm-slim@sha256:...) trong pipeline phát hành.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1) Toàn bộ dependency (để typecheck + build) ---------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages ./packages
COPY services ./services
# Cổng chất lượng trong build: typecheck strict, rồi bundle ra dist/main.js (dependency để ngoài bundle).
RUN npx tsc -p tsconfig.json --noEmit --incremental false \
 && npm run build

# ---- 2) Chỉ dependency production --------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 3) Runtime tối thiểu ----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HCOS_PORT=8080
WORKDIR /app
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# Mã nguồn/ dependency thuộc root và chỉ đọc; tiến trình chạy bằng user `node` (uid 1000), không có shell đăng nhập đặc biệt.
USER node
EXPOSE 8080
# Liveness (không phụ thuộc DB, tránh vòng lặp restart khi DB tạm mất). Readiness dùng GET /readyz ở tầng orchestrator.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HCOS_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# node là PID 1 và tự xử lý SIGTERM/SIGINT (tắt êm, tối đa 10s). Cấu hình HOÀN TOÀN qua biến môi trường lúc chạy.
CMD ["node", "dist/main.js"]
