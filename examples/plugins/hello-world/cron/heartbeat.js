// Cron job "heartbeat" — schedule "*/30 * * * *" (cada 30 min).
// El sandbox no expone setTimeout/setInterval; el scheduling lo hace el motor.
async function handler() {
  logger.info("hello-world heartbeat", new Date().toISOString());
}
