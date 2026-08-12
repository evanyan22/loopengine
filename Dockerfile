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
# file-agent's demo tools read relative to CWD — skills/ and the sample
# files need to ship alongside dist/. A real tool set backed by a DB
# wouldn't need this.
COPY --from=build /app/skills ./skills
COPY --from=build /app/a.txt /app/b.txt ./

EXPOSE 8787
CMD ["node", "dist/adapters/http.js"]
