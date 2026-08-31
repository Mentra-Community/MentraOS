# Local Merge backend image.
#
# Build from the repository root so Bun can resolve workspace packages like
# @mentra/auth without publishing them first.
FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bun.lock package.json ./
COPY cloud-v2/tsconfig.base.json ./cloud-v2/tsconfig.base.json
COPY cloud-v2/packages/shared/package.json ./cloud-v2/packages/shared/package.json
COPY cloud-v2/packages/auth/package.json ./cloud-v2/packages/auth/package.json
COPY cloud-v2/packages/cli/package.json ./cloud-v2/packages/cli/package.json
COPY cloud-v2/packages/cloud-client/package.json ./cloud-v2/packages/cloud-client/package.json
COPY cloud-v2/packages/core/package.json ./cloud-v2/packages/core/package.json
COPY cloud-v2/packages/proxy/package.json ./cloud-v2/packages/proxy/package.json
COPY cloud-v2/packages/runtime/package.json ./cloud-v2/packages/runtime/package.json
COPY miniapps/captions/package.json ./miniapps/captions/package.json
COPY miniapps/everything/package.json ./miniapps/everything/package.json
COPY miniapps/example-miniapp/package.json ./miniapps/example-miniapp/package.json
COPY miniapps/mentra-ai/package.json ./miniapps/mentra-ai/package.json
COPY miniapps/merge/package.json ./miniapps/merge/package.json
COPY miniapps/navigation/package.json ./miniapps/navigation/package.json
COPY miniapps/recorder/package.json ./miniapps/recorder/package.json
COPY miniapps/teleprompter/package.json ./miniapps/teleprompter/package.json
COPY miniapps/translation/package.json ./miniapps/translation/package.json
COPY sdk/miniapp-cli/package.json ./sdk/miniapp-cli/package.json
COPY mobile/modules/miniapp/package.json ./mobile/modules/miniapp/package.json

RUN bun install --ignore-scripts

COPY cloud-v2/packages/auth ./cloud-v2/packages/auth
COPY miniapps/merge/backend ./miniapps/merge/backend
COPY miniapps/merge/package.json ./miniapps/merge/package.json

RUN cd cloud-v2/packages/auth && bun run build

WORKDIR /app/miniapps/merge

EXPOSE 3130

CMD ["bun", "backend/src/index.ts"]
