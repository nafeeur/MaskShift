FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates chromium cmake curl file git jq ninja-build \
      openssh-client python3 python3-pip ripgrep rsync sqlite3 unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/maskshift
COPY . .
RUN chmod +x /opt/maskshift/bin/maskshift.mjs /opt/maskshift/start.sh /opt/maskshift/install.sh \
    && mkdir -p /data /workspace

ENV MASKSHIFT_HOME=/data \
    MASKSHIFT_HOST=0.0.0.0 \
    MASKSHIFT_PORT=4242 \
    MASKSHIFT_MODEL=ollama:auto

VOLUME ["/data", "/workspace"]
EXPOSE 4242

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4242/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "./bin/maskshift.mjs", "serve", "--workspace", "/workspace", "--host", "0.0.0.0", "--port", "4242", "--no-open"]
