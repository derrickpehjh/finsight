FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_API_URL is intentionally empty so the browser uses relative URLs
# that go through Next.js rewrites → backend proxy.
# BACKEND_URL must be set at BUILD time — Next.js bakes rewrites into the build,
# so runtime env vars in docker-compose won't be picked up for rewrite destinations.
ENV NEXT_PUBLIC_API_URL=""
ENV BACKEND_URL=http://backend:8000
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
