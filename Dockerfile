FROM debian:bookworm-slim

RUN apt update && \
    apt install -y \
      curl wget iproute2 iputils-ping bridge-utils net-tools qemu-system-x86 dos2unix xz-utils ca-certificates nodejs cloud-image-utils && \
    rm -rf /var/lib/apt/lists/*

RUN wget -qO /root/debian-cloud.qcow2 \
      https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2

COPY dist/entrypoint.js /root/entrypoint.js
RUN dos2unix /root/entrypoint.js && chmod +x /root/entrypoint.js

ENTRYPOINT ["node", "/root/entrypoint.js"]
