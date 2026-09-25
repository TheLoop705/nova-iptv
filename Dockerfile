# Web build + proxy in one small image:  docker build -t nova . && docker run -p 8787:8787 -e BASIC_AUTH=me:secret nova
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx expo export -p web

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
ENV PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/index.mjs"]
