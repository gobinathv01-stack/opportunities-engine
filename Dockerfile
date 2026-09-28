# One image for everything (API, worker, migrations, seed, tests). It keeps the dev dependencies
# because the `test` service runs Jest from the same image; that is fine for this exercise.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY migrations ./migrations
COPY test ./test
RUN npm run build
CMD ["node", "dist/main.js"]
