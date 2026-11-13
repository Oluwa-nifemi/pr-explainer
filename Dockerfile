FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /srv/pr-explainer

COPY pipeline/package.json pipeline/package-lock.json pipeline/
COPY app/package.json app/package-lock.json app/
RUN npm ci --prefix pipeline && npm ci --prefix app

COPY pipeline pipeline
COPY service service
COPY app app
RUN npm run build --prefix app && npm run build:export --prefix app

RUN mkdir -p /home/node/.config/pr-explainer /home/node/.cache/pr-explainer \
  && chown -R node:node /home/node /srv/pr-explainer/app/node_modules /srv/pr-explainer/app/dist
USER node

ENV PRX_HOST=0.0.0.0
EXPOSE 5180 5190
CMD ["node", "service/src/server.js"]
