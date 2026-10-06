FROM public.ecr.aws/lambda/nodejs:24 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY lambda_function ./lambda_function
COPY scripts/build.mjs ./scripts/build.mjs
RUN node scripts/build.mjs

FROM public.ecr.aws/lambda/nodejs:24
COPY --from=build /build/dist/ ${LAMBDA_TASK_ROOT}/
CMD ["handler.analyzeSentiment"]
