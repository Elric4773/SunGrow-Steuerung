# Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE
FROM docker.io/node:22-alpine
WORKDIR /app

# Konfiguration und Daten liegen im Volume /data (config.json, data/)
ENV NODE_ENV=production \
    PORT=8787 \
    SUNGROW_CONFIG_DIR=/data \
    SUNGROW_SUPERVISED=1

RUN addgroup -S sungrow && adduser -S -G sungrow sungrow \
 && mkdir -p /data && chown sungrow:sungrow /data

COPY --chown=sungrow:sungrow . .

USER sungrow
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/api/setup/status || exit 1
CMD ["node", "server.js"]
