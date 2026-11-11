FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY site ./site
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/outage.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "src/server.js"]
