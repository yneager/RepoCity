FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV REPOCITY_API=http://backend:8000
EXPOSE 5173
# `vite preview` serves the production build and proxies /api to the backend service
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
