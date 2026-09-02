ARG BUN_IMAGE=oven/bun:1.2.23
FROM ${BUN_IMAGE}

WORKDIR /app
RUN rm -rf /app/* /app/.[!.]* /app/..?* || true

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
RUN chmod +x docker/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100 3180 3190

CMD ["sh", "docker/entrypoint.sh"]
