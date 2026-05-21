FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    procps \
    build-essential \
    python3 \
    make \
    g++ \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV npm_config_build_from_source=false

WORKDIR /app
COPY package*.json ./
RUN npm install --prefer-offline || npm install --ignore-scripts && \
    npm rebuild better-sqlite3

COPY . .

ENV NODE_ENV=production

CMD ["node", "server.js"]
