FROM debian:bookworm-slim

RUN apt update && \
    apt install -y \
      curl wget iproute2 iputils-ping bridge-utils net-tools qemu-system-x86 dos2unix xz-utils ca-certificates nodejs && \
    rm -rf /var/lib/apt/lists/*

RUN wget -qO /root/alpine.qcow2 \
      https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/cloud/nocloud_alpine-3.22.2-x86_64-bios-tiny-r0.qcow2

COPY dist/entrypoint.js /root/entrypoint.js
RUN dos2unix /root/entrypoint.js && chmod +x /root/entrypoint.js

ENTRYPOINT ["node", "/root/entrypoint.js"]
