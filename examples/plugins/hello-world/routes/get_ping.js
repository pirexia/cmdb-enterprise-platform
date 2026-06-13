// GET /api/ext/hello-world/ping  (requiresAuth: true)
// Recibe un objeto request-like: { method, path, query, body, user }
// Debe devolver { status?, body? } (o un valor plano → 200 + json).
async function handler(req) {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT count(*)::int AS n FROM plg_hello_world_log"
  );
  return {
    status: 200,
    body: {
      plugin: "hello-world",
      logged: rows[0].n,
      you: req.user ? req.user.role : null,
    },
  };
}
