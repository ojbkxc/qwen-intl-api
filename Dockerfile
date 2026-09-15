FROM node:lts AS BUILD_IMAGE

WORKDIR /app

COPY . /app

RUN yarn config set registry https://registry.npmmirror.com/ \
    && yarn install \
    && yarn run build

FROM node:lts

WORKDIR /app

# Playwright 运行时：安装 chromium 浏览器与系统依赖（对话转发依赖真实浏览器过风控）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
       libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
       libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set registry https://registry.npmmirror.com/ \
    && npx playwright-core install --with-deps chromium \
    && rm -rf /root/.cache/ms-playwright/.links

COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/public /app/public
COPY --from=BUILD_IMAGE /app/node_modules /app/node_modules

EXPOSE 8001

CMD ["npm", "start"]
