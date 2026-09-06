FROM public.ecr.aws/lambda/nodejs:24

COPY lambda_function/handler.js ${LAMBDA_TASK_ROOT}/handler.js

CMD ["handler.analyzeSentiment"]
