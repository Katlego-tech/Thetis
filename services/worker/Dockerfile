FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY --chown=node:node src/main.ts src/main.ts
USER node
CMD ["node", "src/main.ts"]
