FROM mcr.microsoft.com/playwright:v1.40.0-jammy

RUN apt-get update && apt-get install -y \
  procps \
  build-essential \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production

CMD ["node", "server.js"]