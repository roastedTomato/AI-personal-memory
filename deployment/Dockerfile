# Linux image; built locally only. Single architecture must match Lambda.
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /var/task
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt awslambdaric==3.1.1
COPY app ./app
ENV TESSERACT_LANGUAGES=eng PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["app.adapters.lambda_handler.handler"]
