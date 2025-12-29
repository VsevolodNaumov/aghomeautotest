import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { spawn, spawnSync } from 'child_process';

interface DhcpConfig {
  interfaceName: string;
  gatewayIp: string;
  subnetMask: string;
  rangeStart: string;
  rangeEnd: string;
  leaseDuration: number;
  v6RangeStart?: string;
  v6RangeEnd?: string;
  v6LeaseDuration?: number;
}

interface RunnerConfig {
  logPath: string;
  checkInternet: boolean;
  installAdGuard: boolean;
  restartAdGuard: boolean;
  enableQemu: boolean;
  adminUser: string;
  adminPassword: string;
  tapInterface: string;
  hostInterface: string;
  bridgeName: string;
  dhcp: DhcpConfig;
}

const config: RunnerConfig = {
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
};

function ensureLogLocation() {
  const directory = config.logPath.substring(0, config.logPath.lastIndexOf('/'));
  if (directory && !existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

function log(message: string) {
  ensureLogLocation();
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  appendFileSync(config.logPath, `${line}\n`);
}

function runCommand(
  command: string,
  args: string[],
  options: { allowFail?: boolean; captureOutput?: boolean } = {},
): string {
  const prettyCommand = `$ ${command} ${args.join(' ')}`.trim();
  log(prettyCommand);
  const spawnOptions = {
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    encoding: 'utf-8' as const,
  };
  const result = spawnSync(command, args, spawnOptions);

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

async function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  await fetch('http://127.0.0.1:3000/control/install/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      web: { ip: '0.0.0.0', port: 80 },
      dns: { ip: '0.0.0.0', port: 53 },
      username: config.adminUser,
      password: config.adminPassword,
    }),
  }).catch((error) => log(`⚠️  Не удалось выполнить базовую конфигурацию: ${String(error)}`));

  const cookie = await loginAndGetCookie();
  if (!cookie) {
    throw new Error('Не удалось получить cookie сессии AdGuardHome');
  }

  log(`Cookie: ${cookie}`);

  await fetchDhcpInterfaces(cookie);
  await enableDhcp(cookie);
}

async function loginAndGetCookie(): Promise<string | null> {
  const response = await fetch('http://127.0.0.1/control/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: config.adminUser, password: config.adminPassword }),
  });

  const cookies = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (cookies && cookies.length > 0) {
    return cookies[0].split(';')[0];
  }

  const fallback = response.headers.get('set-cookie');
  return fallback ? fallback.split(';')[0] : null;
}

async function fetchDhcpInterfaces(cookie: string) {
  log('Проверка интерфейсов');
  const response = await fetch('http://127.0.0.1/control/dhcp/interfaces', {
    method: 'GET',
    headers: { Cookie: cookie },
  });
  const body = await response.text();
  log(`Статус HTTP: ${response.status}`);
  log(`Ответ DHCP интерфейсов: ${body}`);
}

async function enableDhcp(cookie: string) {
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
      const response = await fetch('http://127.0.0.1/control/dhcp/set_config', {
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
    } catch (error) {
      log(`⚠️  DHCP не ответил: ${String(error)}`);
    }

    await wait(3000);
  }

  throw new Error('DHCP не удалось включить после 10 попыток');
}

function restartAdGuard() {
  if (!config.restartAdGuard) {
    log('⏭️  Пропускаю рестарт AdGuardHome (SKIP_ADGUARD_RESTART=1).');
    return;
  }
  runCommand('/opt/AdGuardHome/AdGuardHome', ['-s', 'restart'], { allowFail: true });
  log('AdGuardHome перезапущен');
}

function checkDhcpPort() {
  const output = runCommand('ss', ['-ulnp'], { captureOutput: true, allowFail: true });
  if (output.includes(':67')) {
    log('✅ DHCP сервер слушает порт 67.');
  } else {
    log('⚠️ DHCP не слушает порт 67 — возможно, интерфейс не поднят.');
  }
}

function startQemu() {
  if (!config.enableQemu) {
    log('⏭️  Пропускаю запуск QEMU (DISABLE_QEMU=1).');
    return;
  }

  log('=== Step 7: Запуск Alpine Linux напрямую ===');
  const qemu = spawn(
    'qemu-system-x86_64',
    [
      '-m',
      '256M',
      '-drive',
      'file=/root/alpine.qcow2,if=virtio,format=qcow2',
      '-boot',
      'c',
      '-nic',
      `tap,ifname=${config.tapInterface},script=no,downscript=no,model=virtio-net-pci`,
      '-serial',
      'mon:stdio',
      '-display',
      'none',
    ],
    { stdio: 'inherit' },
  );

  qemu.on('exit', (code) => {
    log(`QEMU завершился с кодом ${code ?? 0}`);
    process.exit(code ?? 0);
  });
}

async function main() {
  try {
    log('=== Step 0: Проверка интернета ===');
    if (config.checkInternet) {
      try {
        runCommand('ping', ['-c', '2', '8.8.8.8']);
        log('✅ Интернет работает');
      } catch (error) {
        log(`⚠️ Нет интернета: ${String(error)}`);
      }
    } else {
      log('⏭️  Проверка интернета пропущена (SKIP_INTERNET_CHECK=1).');
    }

    await installAdGuardHome();
    createInternalNetwork();
    restartInterfaces();
    restartAdGuard();
    await wait(2000);
    await configureAdGuardHome();
    restartAdGuard();
    await wait(5000);
    checkDhcpPort();
    startQemu();
  } catch (error) {
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
