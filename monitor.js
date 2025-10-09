// monitor.js
// Petit script de supervision des services avec notification Discord

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK_URL) throw new Error("❌ DISCORD_WEBHOOK manquant dans le .env");

const SERVICES = [
  { name: "Site principal", url: "https://mhemery.fr" },
  { name: "Kidouille", url: "https://kidouille.mhemery.fr" },
  { name: "Sonora Dev", url: "https://sonora-dev.mhemery.fr/health" },
];

// Mémoire locale pour éviter le spam
const lastStatus = {};

async function checkService(service) {
  try {
    const res = await fetch(service.url, { method: "GET", timeout: 8000 });
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
  const body = {
    embeds: [
      {
        title: `🚨 Service DOWN : ${service.name}`,
        description: `**URL :** ${service.url}\n**Code :** ${status}`,
        color: 0xff0000,
        timestamp: new Date(),
      },
    ],
  };
  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendDiscordRecovery(service) {
  const body = {
    embeds: [
      {
        title: `✅ Service rétabli : ${service.name}`,
        description: `**URL :** ${service.url}`,
        color: 0x00ff00,
        timestamp: new Date(),
      },
    ],
  };
  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Boucle principale
async function main() {
  for (const s of SERVICES) await checkService(s);
}
main();
setInterval(main, 120 * 1000); // Vérifie toutes les 120s
