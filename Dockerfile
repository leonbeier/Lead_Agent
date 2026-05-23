FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY hubspot-ui ./hubspot-ui
COPY docs ./docs
COPY data ./data
COPY README.md ./README.md
COPY AGENTS.md ./AGENTS.md
COPY tests ./tests

RUN npx tsc -p tsconfig.json

EXPOSE 3000

CMD ["npm", "run", "start"]