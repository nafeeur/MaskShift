FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates chromium cmake curl file git jq ninja-build \
      openssh-client python3 python3-pip ripgrep rsync sqlite3 unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/maskshift
COPY . .
RUN chmod +x /opt/maskshift/bin/maskshift.mjs /opt/maskshift/start.sh /opt/maskshift/install.sh \
    && ln -sf /opt/maskshift/bin/maskshift.mjs /usr/local/bin/maskshift \
    && mkdir -p /data /workspace

ENV MASKSHIFT_HOME=/data \
    MASKSHIFT_MODEL=ollama:auto \
    TERM=xterm-256color \
    COLORTERM=truecolor

VOLUME ["/data", "/workspace"]
WORKDIR /workspace

# MaskShift is a terminal application: run it with `docker run -it` so the TUI
# gets a real TTY, or pass a subcommand such as `run "…"` for headless work.
HEALTHCHECK --interval=60s --timeout=20s --start-period=15s --retries=3 \
  CMD node --no-warnings /opt/maskshift/bin/maskshift.mjs doctor --json > /dev/null || exit 1

ENTRYPOINT ["node", "--no-warnings", "/opt/maskshift/bin/maskshift.mjs"]
CMD ["tui", "--workspace", "/workspace"]
