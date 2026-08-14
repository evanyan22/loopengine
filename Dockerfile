FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# file-agent's demo tools read relative to CWD — the sample files and
# every agent's SKILL.md need to ship alongside dist/. A real tool set
# backed by a DB wouldn't need this. Every agent's skills/tools now live
# under its own agents/<name>/ folder (see README's "Project layout"), so
# copying the whole agents/ source tree is what picks all of that up in
# one line (its .ts files are redundant with dist/agents/ but harmless;
# there's no clean per-file-type COPY filter to avoid that redundancy,
# and this repo isn't optimizing for minimal image size). Root skills/
# and tools/ exist too (reserved for genuinely cross-agent content) but
# hold only a README.md each right now — pure dev docs, nothing a
# runtime import ever reaches, so they're deliberately not copied here.
COPY --from=build /app/agents ./agents
COPY --from=build /app/examples ./examples

EXPOSE 8787
CMD ["node", "dist/adapters/http.js"]
