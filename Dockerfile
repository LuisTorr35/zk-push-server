# ---- Build stage ----
FROM node:22-alpine AS build
# Prisma's query engine needs OpenSSL, which alpine does not ship
RUN apk add --no-cache openssl
WORKDIR /app
# Run as the image's "node" user (uid 1000). Files the dev container writes
# into mounted folders, like new migrations, then belong to the host user
# instead of root.
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npx prisma generate
RUN npm run build

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Generated Prisma client (the CLI that creates it is a dev dependency)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
