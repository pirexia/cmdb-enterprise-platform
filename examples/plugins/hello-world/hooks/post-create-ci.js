// Hook post-creación de CI. Payload: { id, body, user }
// Disponible en el sandbox: prisma (scoped al rol cmdb_plugin), logger, config, fetch, console, JSON, Math, Date...
async function handler(data) {
  await prisma.$executeRaw`
    INSERT INTO plg_hello_world_log (ci_id) VALUES (${data.id}::uuid)
  `;
  logger.info("hello-world: CI registrado", data.id);
}
