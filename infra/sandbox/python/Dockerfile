FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m pip install --no-cache-dir \
        build==1.3.0 \
        mypy==1.19.1 \
        pytest==8.3.5 \
        ruff==0.16.3 \
        setuptools==75.8.0 \
        wheel==0.45.1 \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid sandbox --create-home --home-dir /home/sandbox sandbox

COPY --chown=sandbox:sandbox run_python_build.py /opt/bit-agent/run_python_build.py

USER sandbox:sandbox
WORKDIR /workspace

CMD ["python"]
