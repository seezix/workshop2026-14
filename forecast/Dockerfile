# Sentinel-X service de prévision
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY Code_ai_predict.py ./
USER nobody
CMD ["python", "Code_ai_predict.py"]
