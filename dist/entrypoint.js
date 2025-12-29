"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const defaultHostname = process.env.CLOUDINIT_HOSTNAME ?? 'test.xyz';
const defaultCloudInitCommands = [
    'echo "AdGuardHome test VM is ready"',
    `hostname ${defaultHostname}`,
    `udhcpc -i eth0 -v -x hostname:${defaultHostname}`,
    'LEASE_IP=$(ip -4 addr show dev eth0 | awk "/inet / {print $2}")',
    'CURRENT_HOSTNAME=$(hostname)',
    'if [ -z "$LEASE_IP" ]; then echo "❌ DHCP lease for eth0 is empty"; exit 1; fi',
    `if [ "$CURRENT_HOSTNAME" != "${defaultHostname}" ]; then echo "❌ Hostname is $CURRENT_HOSTNAME, expected ${defaultHostname}"; exit 1; fi`,
    'echo "✅ DHCP lease obtained: $LEASE_IP with hostname $CURRENT_HOSTNAME"',
];
const config = {
    logPath: process.env.LOG_PATH ?? '/var/log/startup.log',
    checkInternet: process.env.SKIP_INTERNET_CHECK !== '1',
    installAdGuard: process.env.SKIP_ADGUARD_INSTALL !== '1',
    restartAdGuard: process.env.SKIP_ADGUARD_RESTART !== '1',
    enableQemu: process.env.DISABLE_QEMU !== '1',
    adminUser: process.env.ADGUARD_USER ?? 'admin',
    adminPassword: process.env.ADGUARD_PASSWORD ?? '123123123',
    tapInterface: process.env.TAP_INTERFACE ?? 'tap0',
    hostInterface: process.env.HOST_INTERFACE ?? 'veth-host',
    bridgeName: process.env.BRIDGE_NAME ?? 'br0',
    dhcp: {
        interfaceName: process.env.DHCP_INTERFACE ?? 'br0',
        gatewayIp: process.env.DHCP_GATEWAY ?? '10.99.0.1',
        subnetMask: process.env.DHCP_SUBNET_MASK ?? '255.255.255.0',
        rangeStart: process.env.DHCP_RANGE_START ?? '10.99.0.10',
        rangeEnd: process.env.DHCP_RANGE_END ?? '10.99.0.20',
        leaseDuration: Number(process.env.DHCP_LEASE_DURATION ?? '86400'),
        v6RangeStart: process.env.DHCP_V6_RANGE_START ?? '2001::1',
        v6RangeEnd: process.env.DHCP_V6_RANGE_END ?? '',
        v6LeaseDuration: Number(process.env.DHCP_V6_LEASE_DURATION ?? '86400'),
    },
    cloudInit: {
        hostname: defaultHostname,
        password: process.env.CLOUDINIT_PASSWORD ?? 'alpine',
        seedImagePath: process.env.CLOUDINIT_SEED_PATH ?? '/root/cloudinit-seed.img',
        imagePath: process.env.CLOUDINIT_IMAGE_PATH ?? '/root/alpine.qcow2',
        commands: process.env.CLOUDINIT_COMMANDS?.split(';')
            .map((item) => item.trim())
            .filter(Boolean) ?? defaultCloudInitCommands,
    },
};
function ensureLogLocation() {
    const directory = config.logPath.substring(0, config.logPath.lastIndexOf('/'));
    if (directory && !(0, fs_1.existsSync)(directory)) {
        (0, fs_1.mkdirSync)(directory, { recursive: true });
    }
}
function log(message) {
    ensureLogLocation();
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    (0, fs_1.appendFileSync)(config.logPath, `${line}\n`);
}
function runCommand(command, args, options = {}) {
    const prettyCommand = `$ ${command} ${args.join(' ')}`.trim();
    log(prettyCommand);
    const spawnOptions = {
        stdio: options.captureOutput ? 'pipe' : 'inherit',
        encoding: 'utf-8',
    };
    const result = (0, child_process_1.spawnSync)(command, args, spawnOptions);
    if (result.error) {
        if (options.allowFail) {
            log(`⚠️  Ошибка выполнения ${prettyCommand}: ${result.error.message}`);
            return result.stdout?.toString() ?? '';
        }
        throw result.error;
    }
    if (result.status !== 0 && !options.allowFail) {
        throw new Error(`Команда завершилась с кодом ${result.status}: ${prettyCommand}`);
    }
    if (result.status !== 0) {
        log(`⚠️  Команда завершилась с кодом ${result.status}`);
    }
    if (options.captureOutput) {
        return result.stdout?.toString() ?? '';
    }
    return '';
}
async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function installAdGuardHome() {
    if (!config.installAdGuard) {
        log('⏭️  Пропускаю установку AdGuardHome (SKIP_ADGUARD_INSTALL=1).');
        return;
    }
    log('=== Step 1: Установка AdGuardHome ===');
    runCommand('sh', [
        '-c',
        'curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v -r',
    ]);
    log('Принудительный запуск AdGuardHome после установки');
    runCommand('sh', ['-c', 'cd /opt/AdGuardHome && ./AdGuardHome -s start'], { allowFail: true });
    log('✅ AdGuardHome установлен');
}
function createInternalNetwork() {
    log('=== Step 2: Создание внутренней сети (veth + tap через bridge) ===');
    runCommand('ip', ['link', 'add', config.hostInterface, 'type', 'veth', 'peer', 'name', 'veth-tap'], {
        allowFail: true,
    });
    runCommand('ip', ['addr', 'add', `${config.dhcp.gatewayIp}/24`, 'dev', config.hostInterface], { allowFail: true });
    runCommand('ip', ['link', 'set', config.hostInterface, 'up']);
    runCommand('ip', ['link', 'set', 'veth-tap', 'up']);
    runCommand('ip', ['tuntap', 'add', 'dev', config.tapInterface, 'mode', 'tap'], { allowFail: true });
    runCommand('ip', ['link', 'set', config.tapInterface, 'up']);
    runCommand('brctl', ['addbr', config.bridgeName], { allowFail: true });
    runCommand('brctl', ['addif', config.bridgeName, config.hostInterface], { allowFail: true });
    runCommand('brctl', ['addif', config.bridgeName, config.tapInterface], { allowFail: true });
    runCommand('ip', ['link', 'set', config.bridgeName, 'up']);
    runCommand('ip', ['addr', 'add', `${config.dhcp.gatewayIp}/24`, 'dev', config.bridgeName], { allowFail: true });
    log(`✅ Мост ${config.bridgeName} готов: ${config.hostInterface} ↔ ${config.tapInterface} (${config.dhcp.gatewayIp}/24)`);
}
function restartInterfaces() {
    log('=== Step 3: Перезапуск сетевых интерфейсов ===');
    const targets = [config.hostInterface, 'veth-tap', config.tapInterface, config.bridgeName];
    for (const iface of targets) {
        runCommand('ip', ['link', 'set', iface, 'down'], { allowFail: true });
        runCommand('ip', ['link', 'set', iface, 'up'], { allowFail: true });
    }
    log('✅ Сеть перезапущена');
}
async function configureAdGuardHome() {
    log('=== Step 5: Настройка AdGuardHome ===');
    let adGuardPort = await waitForAdGuardWeb([3000, 80], 30, 2000);
    let baseUrl = `http://127.0.0.1:${adGuardPort}`;
    if (adGuardPort === 3000) {
        await withRetries(async () => {
            const configureResponse = await fetch(`${baseUrl}/control/install/configure`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    web: { ip: '0.0.0.0', port: 80 },
                    dns: { ip: '0.0.0.0', port: 53 },
                    username: config.adminUser,
                    password: config.adminPassword,
                }),
            });
            if (!configureResponse.ok) {
                const body = await configureResponse.text();
                throw new Error(`Не удалось выполнить базовую конфигурацию: HTTP ${configureResponse.status} ${body}`);
            }
        }, 10, 3000, 'выполнить базовую конфигурацию AdGuardHome');
        adGuardPort = await waitForAdGuardWeb([80], 20, 2000);
        baseUrl = `http://127.0.0.1:${adGuardPort}`;
    }
    else {
        log('⏭️  Базовая конфигурация пропущена: AdGuardHome уже доступен на порту 80.');
    }
    const cookie = await withRetries(async () => {
        const sessionCookie = await loginAndGetCookie(baseUrl);
        if (!sessionCookie) {
            throw new Error('Не удалось получить cookie сессии AdGuardHome');
        }
        return sessionCookie;
    }, 10, 2000, 'получить cookie сессии AdGuardHome');
    log(`Cookie: ${cookie}`);
    await fetchDhcpInterfaces(baseUrl, cookie);
    await enableDhcp(baseUrl, cookie);
}
async function loginAndGetCookie(baseUrl) {
    const response = await fetch(`${baseUrl}/control/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: config.adminUser, password: config.adminPassword }),
    });
    const cookies = response.headers.getSetCookie?.();
    if (cookies && cookies.length > 0) {
        return cookies[0].split(';')[0];
    }
    const fallback = response.headers.get('set-cookie');
    return fallback ? fallback.split(';')[0] : null;
}
async function fetchDhcpInterfaces(baseUrl, cookie) {
    log('Проверка интерфейсов');
    const response = await fetch(`${baseUrl}/control/dhcp/interfaces`, {
        method: 'GET',
        headers: { Cookie: cookie },
    });
    const body = await response.text();
    log(`Статус HTTP: ${response.status}`);
    log(`Ответ DHCP интерфейсов: ${body}`);
}
async function enableDhcp(baseUrl, cookie) {
    log('=== Step 6: Настройка DHCP ===');
    const payload = {
        enabled: true,
        interface_name: config.dhcp.interfaceName,
        v4: {
            gateway_ip: config.dhcp.gatewayIp,
            subnet_mask: config.dhcp.subnetMask,
            range_start: config.dhcp.rangeStart,
            range_end: config.dhcp.rangeEnd,
            lease_duration: config.dhcp.leaseDuration,
        },
        v6: {
            range_start: config.dhcp.v6RangeStart,
            range_end: config.dhcp.v6RangeEnd,
            lease_duration: config.dhcp.v6LeaseDuration,
        },
    };
    for (let attempt = 1; attempt <= 10; attempt += 1) {
        log(`Попытка включить DHCP (${attempt})...`);
        try {
            const response = await fetch(`${baseUrl}/control/dhcp/set_config`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: cookie,
                },
                body: JSON.stringify(payload),
            });
            const body = await response.text();
            log(`DHCP ответил статусом ${response.status}: ${body}`);
            if (response.ok) {
                log(`✅ DHCP включён на ${config.dhcp.interfaceName}`);
                return;
            }
        }
        catch (error) {
            log(`⚠️  DHCP не ответил: ${String(error)}`);
        }
        await wait(3000);
    }
    throw new Error('DHCP не удалось включить после 10 попыток');
}
async function waitForAdGuardHome(url, attempts = 15, delayMs = 2000) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(url, { method: 'GET' });
            log(`Проверка доступности AdGuardHome (${attempt}/${attempts}): HTTP ${response.status}`);
            if (response.ok || (response.status >= 400 && response.status < 500)) {
                return;
            }
        }
        catch (error) {
            log(`AdGuardHome не отвечает (${attempt}/${attempts}): ${String(error)}`);
        }
        await wait(delayMs);
    }
    throw new Error(`AdGuardHome не доступен после ${attempts} попыток`);
}
async function withRetries(fn, attempts, delayMs, label) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await fn();
        }
        catch (error) {
            log(`Попытка ${label} (${attempt}/${attempts}) не удалась: ${String(error)}`);
            if (attempt < attempts) {
                await wait(delayMs);
            }
        }
    }
    throw new Error(`Не удалось ${label} после ${attempts} попыток`);
}
async function waitForAdGuardWeb(ports, attempts = 15, delayMs = 2000) {
    for (const port of ports) {
        try {
            await waitForAdGuardHome(`http://127.0.0.1:${port}`, attempts, delayMs);
            log(`✅ AdGuardHome отвечает на порту ${port}`);
            return port;
        }
        catch (error) {
            log(`⚠️  AdGuardHome не ответил на порту ${port}: ${String(error)}`);
        }
    }
    throw new Error(`AdGuardHome не доступен ни на одном из портов: ${ports.join(', ')}`);
}
async function restartAdGuard() {
    if (!config.restartAdGuard) {
        log('⏭️  Пропускаю рестарт AdGuardHome (SKIP_ADGUARD_RESTART=1).');
        return;
    }
    runCommand('sh', ['-c', 'cd /opt/AdGuardHome && ./AdGuardHome']);
    log('♻️  AdGuardHome перезапускается, ожидаем веб-интерфейс...');
    await waitForAdGuardWeb([80]);
}
function checkDhcpPort() {
    const output = runCommand('ss', ['-ulnp'], { captureOutput: true, allowFail: true });
    if (output.includes(':67')) {
        log('✅ DHCP сервер слушает порт 67.');
    }
    else {
        log('⚠️ DHCP не слушает порт 67 — возможно, интерфейс не поднят.');
    }
}
function startQemu() {
    if (!config.enableQemu) {
        log('⏭️  Пропускаю запуск QEMU (DISABLE_QEMU=1).');
        return;
    }
    log('=== Step 7: Подготовка cloud-init и запуск Alpine Linux ===');
    const cloudInitImage = prepareCloudInitImage();
    if (!(0, fs_1.existsSync)(config.cloudInit.imagePath)) {
        throw new Error(`Файл образа гостя не найден: ${config.cloudInit.imagePath}`);
    }
    const qemu = (0, child_process_1.spawn)('qemu-system-x86_64', [
        '-m',
        '256M',
        '-drive',
        `file=${config.cloudInit.imagePath},if=virtio,format=qcow2`,
        '-boot',
        'c',
        '-drive',
        `file=${cloudInitImage},if=virtio,format=raw`,
        '-nic',
        `tap,ifname=${config.tapInterface},script=no,downscript=no,model=virtio-net-pci`,
        '-serial',
        'mon:stdio',
        '-display',
        'none',
    ], { stdio: 'inherit' });
    qemu.on('exit', (code) => {
        log(`QEMU завершился с кодом ${code ?? 0}`);
        process.exit(code ?? 0);
    });
}
function prepareCloudInitImage() {
    const workspace = (0, fs_1.mkdtempSync)('/tmp/cloudinit-');
    const userDataPath = path_1.default.join(workspace, 'user-data');
    const metaDataPath = path_1.default.join(workspace, 'meta-data');
    const networkConfigPath = path_1.default.join(workspace, 'network-config');
    const networkConfig = ['version: 2', 'ethernets:', '  eth0:', '    dhcp4: true', '    dhcp6: false'].join('\n');
    (0, fs_1.writeFileSync)(networkConfigPath, `${networkConfig}\n`);
    const commandLines = config.cloudInit.commands.length > 0
        ? config.cloudInit.commands
        : ['echo "AdGuardHome test VM is ready"'];
    const renderedCommands = commandLines
        .map((command) => command.replace(/"/g, '\\"'))
        .map((command) => `  - ["/bin/sh", "-c", "${command}"]`)
        .join('\n');
    const userData = [
        '#cloud-config',
        `hostname: ${config.cloudInit.hostname}`,
        `password: ${config.cloudInit.password}`,
        'ssh_pwauth: true',
        'chpasswd: { expire: false }',
        'write_files:',
        '  - path: /etc/network/interfaces',
        "    permissions: '0644'",
        '    content: |',
        '      auto lo',
        '      iface lo inet loopback',
        '      auto eth0',
        '      iface eth0 inet dhcp',
        'runcmd:',
        renderedCommands,
    ].join('\n');
    (0, fs_1.writeFileSync)(userDataPath, `${userData}\n`);
    (0, fs_1.writeFileSync)(metaDataPath, `instance-id: alpine-adguard\nlocal-hostname: ${config.cloudInit.hostname}\n`);
    runCommand('cloud-localds', ['-N', networkConfigPath, config.cloudInit.seedImagePath, userDataPath, metaDataPath]);
    log(`Cloud-init seed образ создан: ${config.cloudInit.seedImagePath}`);
    return config.cloudInit.seedImagePath;
}
async function main() {
    try {
        log('=== Step 0: Проверка интернета ===');
        if (config.checkInternet) {
            try {
                runCommand('ping', ['-c', '2', '8.8.8.8']);
                log('✅ Интернет работает');
            }
            catch (error) {
                log(`⚠️ Нет интернета: ${String(error)}`);
            }
        }
        else {
            log('⏭️  Проверка интернета пропущена (SKIP_INTERNET_CHECK=1).');
        }
        await installAdGuardHome();
        createInternalNetwork();
        restartInterfaces();
        await restartAdGuard();
        await wait(2000);
        await configureAdGuardHome();
        await restartAdGuard();
        await wait(5000);
        checkDhcpPort();
        startQemu();
    }
    catch (error) {
        log(`[!] Ошибка: ${String(error)}. Оставляю контейнер живым.`);
        keepAlive();
    }
}
function keepAlive() {
    log('Переходим в режим ожидания после ошибки.');
    setInterval(() => {
        log('Контейнер остаётся активным после ошибки.');
    }, 60_000);
}
main();
