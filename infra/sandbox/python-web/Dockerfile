FROM bit-agent-python-sandbox:0.1.0

USER root

RUN python -m pip install --no-cache-dir \
        "fastapi>=0.110,<1" \
        "httpx>=0.26,<1" \
        "pillow>=10,<13" \
        "pytesseract>=0.3.10,<1" \
        "python-multipart>=0.0.9,<1"

USER sandbox:sandbox
WORKDIR /workspace
