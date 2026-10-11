FROM python:3.12-slim

# git is the only system dependency (cloning, log, blame). No code from analysed repositories is executed.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY pyproject.toml ./
COPY repocity ./repocity
RUN pip install --no-cache-dir --no-deps -e .

ENV REPOCITY_DATA_DIR=/data \
    REPOCITY_DEMO_DIR=/app/demo/cache \
    PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["uvicorn", "repocity.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
