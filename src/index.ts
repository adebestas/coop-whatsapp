import { buildApp } from "./app.js";
import { config } from "./config.js";

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Coop WhatsApp bot running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();