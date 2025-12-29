#!/bin/bash
set -e
LOG="/var/log/startup.log"
log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }


set -e
trap 'echo "[!] Ошибка на строке $LINENO, оставляю контейнер живым"; sleep infinity' ERR



log "=== Step 0: Проверка интернета ==="
ping -c 2 8.8.8.8 && log "✅ Интернет работает" || log "⚠️ Нет интернета"

# === Установка AdGuardHome ===
log "=== Step 1: Установка AdGuardHome ==="
curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v -r
log "✅ AdGuardHome установлен"

log "=== Step 2: Создание внутренней сети (veth + tap через bridge) ==="

# создаём veth-пару
ip link add veth-host type veth peer name veth-tap || true
ip addr add 10.99.0.1/24 dev veth-host || true
ip link set veth-host up
ip link set veth-tap up

# создаём tap-интерфейс для QEMU
ip tuntap add dev tap0 mode tap || true
ip link set tap0 up

# делаем мост между AdGuard (veth-host) и VM (tap0)
brctl addbr br0 || true
brctl addif br0 veth-host || true
brctl addif br0 tap0 || true
ip link set br0 up
ip addr add 10.99.0.1/24 dev br0 || true

log "✅ Мост br0 готов: veth-host ↔ tap0 (10.99.0.1/24)"



# === Перезапуск networking (ручной, т.к. systemd нет) ===
log "=== Step 3: Перезапуск сетевых интерфейсов ==="
ip link set veth-host down && ip link set veth-host up
ip link set veth-guest down && ip link set veth-guest up
sleep 2
log "✅ Сеть перезапущена"

# === Перезапуск AdGuardHome ===
log "=== Step 4: Перезапуск AdGuardHome для подхвата интерфейсов ==="
#/opt/AdGuardHome/AdGuardHome -s restart
#sleep 5


# === Базовая настройка и логин ===
log "=== Step 5: Настройка AdGuardHome ==="
curl -s -D - -o - 'http://127.0.0.1:3000/control/install/configure' \
  -X POST -H 'Content-Type: application/json' \
  --data-raw '{"web":{"ip":"0.0.0.0","port":80},"dns":{"ip":"0.0.0.0","port":53},"username":"admin","password":"123123123"}' || true

COOKIE=$(curl -s -D - -o /dev/null -X POST http://127.0.0.1/control/login \
  -H "Content-Type: application/json" \
  --data '{"name":"admin","password":"123123123"}' | grep -o 'agh_session=[^;]*')
log "Cookie: $COOKIE"

# === Определяем интерфейс, видимый AdGuardHome ===
IFACE=$(ip -o link show | awk -F': ' '{print $2}' | grep -vE 'lo|veth|br0' | head -n1)
log "Используем интерфейс для DHCP: $IFACE"


log "Проверка интерфейсов"

HTTP_STATUS=$(curl -s -v -o /tmp/dhcp_body.txt -w "%{http_code}" \
  'http://127.0.0.1/control/dhcp/interfaces' \
  -X GET \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Language: en-US,en;q=0.5' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1' \
  -H 'Connection: keep-alive' \
  -H 'Referer: http://127.0.0.1/' \
  -H "Cookie: $COOKIE" \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'Priority: u=0' \
)

BODY=$(cat /tmp/dhcp_body.txt)

log "Статус HTTP: $HTTP_STATUS"
log "Ответ DHCP интерфейсов:"
echo "$BODY" | tee -a "$LOG"

# === DHCP через реалистичный браузерный curl ===
log "=== Step 6: Настройка DHCP ==="
for attempt in {1..10}; do
  log "Попытка включить DHCP ($attempt)..."
  HTTP_STATUS=$(curl -s -v -o /tmp/dhcp_body.txt -w "%{http_code}" \
    'http://127.0.0.1/control/dhcp/set_config' \
    -X POST \
    -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' \
    -H 'Accept: application/json, text/plain, */*' \
    -H 'Accept-Language: en-US,en;q=0.5' \
    -H 'Accept-Encoding: gzip, deflate, br, zstd' \
    -H 'Content-Type: application/json' \
    -H 'Origin: http://127.0.0.1' \
    -H 'Connection: keep-alive' \
    -H 'Referer: http://127.0.0.1/' \
    -H "Cookie: $COOKIE" \
    -H 'Sec-Fetch-Dest: empty' \
    -H 'Sec-Fetch-Mode: cors' \
    -H 'Sec-Fetch-Site: same-origin' \
    -H 'Priority: u=0' \
    --data-raw "{\"enabled\":true,\"interface_name\":\"br0\",\"v4\":{\"gateway_ip\":\"10.99.0.1\",\"subnet_mask\":\"255.255.255.0\",\"range_start\":\"10.99.0.10\",\"range_end\":\"10.99.0.20\",\"lease_duration\":86400},\"v6\":{\"range_start\":\"2001::1\",\"lease_duration\":86400,\"range_end\":\"\"}}" \
  ) || true

if [ "$HTTP_STATUS" == "000" ]; then
    log "✅ DHCP включён на $IFACE (статус 200)"
    break
else
    if [ "$HTTP_STATUS" == "000" ]; then
        sleep 15
        log "⚠️ DHCP не ответил (статус $HTTP_STATUS)"
        sleep 3
    fi
fi
done

/opt/AdGuardHome/AdGuardHome -s restart
sleep 5

if ! ss -ulnp | grep -q ":67"; then
  log "⚠️ DHCP не слушает порт 67 — возможно, интерфейс $IFACE не поднят."
else
  log "✅ DHCP сервер слушает порт 67."
fi

# === Step 7: Запуск Alpine Linux (прямой boot, без seed) ===
log "=== Step 7: Запуск Alpine Linux напрямую ==="

exec qemu-system-x86_64 \
  -m 256M \
  -drive file=/root/alpine.qcow2,if=virtio,format=qcow2 \
  -boot c \
  -nic tap,ifname=tap0,script=no,downscript=no,model=virtio-net-pci \
  -serial mon:stdio \
  -display none