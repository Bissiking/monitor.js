// monitor.js
// Petit script de supervision des services avec notification Discord (Docker-friendly)

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK_URL) throw new Error("❌ Variable d'environnement DISCORD_WEBHOOK manquante");

const SERVICES = [
  { name: "Site principal", url: "https://mhemery.fr" },
  { name: "Kidouille", url: "https://kidouille.mhemery.fr" },
  { name: "Sonora Dev", url: "https://sonora-dev.mhemery.fr/health" },
];

const lastStatus = {};

async function checkService(service) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(service.url, { signal: controller.signal });
    clearTimeout(timeout);

    const ok = res.status >= 200 && res.status < 300;

    if (!ok && lastStatus[service.url] !== "DOWN") {
      await sendDiscordAlert(service, res.status);
      lastStatus[service.url] = "DOWN";
      console.log(`❌ ${service.name} → ${res.status}`);
    } else if (ok && lastStatus[service.url] === "DOWN") {
      await sendDiscordRecovery(service);
      lastStatus[service.url] = "UP";
      console.log(`✅ ${service.name} → Revenu UP (${res.status})`);
    } else {
      lastStatus[service.url] = "UP";
      console.log(`🟢 ${service.name} → ${res.status}`);
    }
  } catch (err) {
    if (lastStatus[service.url] !== "DOWN") {
      await sendDiscordAlert(service, "No response");
      lastStatus[service.url] = "DOWN";
    }
    console.log(`⚠️ ${service.name} → ${err.message}`);
  }
}

async function sendDiscordAlert(service, status) {
  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: `🚨 Service DOWN : ${service.name}`,
          description: `**URL :** ${service.url}\n**Code :** ${status}`,
          color: 0xff0000,
          timestamp: new Date(),
        },
      ],
    }),
  });
}

async function sendDiscordRecovery(service) {
  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: `✅ Service rétabli : ${service.name}`,
          description: `**URL :** ${service.url}`,
          color: 0x00ff00,
          timestamp: new Date(),
        },
      ],
    }),
  });
}

async function main() {
  for (const s of SERVICES) await checkService(s);
}
main();
setInterval(main, 120 * 1000); // Vérifie toutes les 2 minutes
