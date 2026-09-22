FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# DejaVu stays as the system fallback for glyphs the vendored client fonts lack.
RUN apk add --no-cache fontconfig font-dejavu

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
# Client fonts for text metrics and the PNG renderer (resolved from dist/verify).
COPY assets ./assets

EXPOSE 3015
CMD ["node", "dist/index.js"]
