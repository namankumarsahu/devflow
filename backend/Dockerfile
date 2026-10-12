FROM node:20-alpine
RUN apk add --no-cache git docker-cli openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/server.js"]  