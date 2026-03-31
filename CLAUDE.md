# CLAUDE.md - CMDB Enterprise Platform (Dachser Standard)

## 🛠 Entorno y Comandos de Operación
> **Nota:** El proyecto opera en un flujo híbrido (Desarrollo en WSL2/Ubuntu y Producción en RHEL 9).
- **Levantar Entorno:** `docker-compose up -d --build` (WSL2) o `podman-compose up -d --build` (RHEL).
- **Gestión de Base de Datos:**
  - Aplicar cambios al esquema: `npx prisma migrate dev`
  - Desplegar en servidor: `podman exec -it cmdb-backend npx prisma migrate deploy`
  - Generar Cliente: `npx prisma generate`
- **Shell de Contenedor:** `[docker|podman] exec -it cmdb-backend sh`
- **Backup de DB:** `podman exec cmdb-postgres pg_dump -U cmdb_db_user cmdb_prod > backup_$(date +%F).sql`

## 🏗 Stack Tecnológico
- **Frontend:** Next.js 15+ (App Router), TypeScript, Tailwind CSS.
- **UI & Icons:** Shadcn/UI, Lucide React (Iconografía uniforme).
- **Backend:** Node.js Express API.
- **ORM:** Prisma (PostgreSQL).
- **Seguridad:** NextAuth.js, LDAP/AD Integration, MFA (Totp).

## 🛡️ Estándares de Seguridad y Ciberseguridad
1. **Directivas ISO 27001:** - Todo acceso a datos sensibles debe estar autenticado.
   - Implementar el "Principio de Menor Privilegio" (PoLP) en todas las funciones.
   - Los datos en tránsito deben usar TLS 1.3+.
2. **Cumplimiento OWASP Top 10:** - Prevención de Inyección (SQL/NoSQL) mediante el uso estricto de Prisma ORM (Typed Queries).
   - Sanitización de entradas en el Frontend y Backend para evitar XSS.
   - Gestión segura de sesiones y protección contra CSRF.
   - Desactivar el listado de directorios y headers sensibles (usar `helmet` en Express).
3. **Blindaje de API:**
   - Implementar Rate Limiting para prevenir ataques de fuerza bruta.
   - Validación de esquemas estricta con **Zod** para todas las peticiones entrantes.
4. **Trazabilidad y Auditabilidad:**
   - Cada acción de lectura/escritura en CIs Críticos debe registrar: Usuario, Timestamp, IP de origen, Acción y Estado previo/posterior.
   - Los logs de auditoría deben ser inmutables (no editables desde la UI).
5. **Secretos:** - Prohibido subir `.env` o llaves SSH al repositorio. Usar variables de entorno del sistema o Vaults.

## 🌍 Cumplimiento Normativo y Compliance
- **ISO 27001:** Control de acceso basado en roles (RBAC) y principio de menor privilegio.
- **NIS2 Ready:** - Trazabilidad total del ciclo de vida del CI.
  - Campos obligatorios de Resiliencia: `Business_Impact`, `Recovery_Priority`, `RTO/RPO`.
- **ISO 22301:** El Mapa de Dependencias debe identificar visualmente Puntos Únicos de Fallo (SPOF).
- **GDPR/RGPD:** Flag `Contains_PII` en CIs de datos y anonimización de logs antiguos.

## 📏 Guía de Desarrollo "Dachser Enterprise"
3. **Internacionalización:** No hardcodear textos. Preparar la UI para ser bilingüe.
4. **UI Limpia:** Herramientas técnicas (SSL, Logs, Admin) deben residir dentro de la pestaña "Configuración".
5. **Manejo de Errores:** Nunca exponer stack traces al usuario final (Information Exposure prevention).

## 🏁 Protocolo de Entrega (Definition of Done) - CRÍTICO
1. **Prueba Local Previa:** Prohibido subir cambios a GitHub sin haber probado la funcionalidad en el entorno local (WSL2/RHEL) y confirmado que el build es exitoso.
2. **Documentación Obligatoria:** Todo `fix` o `feat` debe actualizar:
   - `README.md` (si hay cambios técnicos/dependencias).
   - `USER_MANUAL.md` (si hay cambios visuales o de flujo).
3. **Validación de Tipos:** El comando `npm run build` o `npx tsc` debe pasar sin errores antes de hacer commit.

## 📂 Estructura Clave
- `frontend/app/`: Rutas del sistema.
- `frontend/components/`: Modales y componentes UI (AddCI, EditCI, AddRelation).
- `backend/prisma/schema.prisma`: Única fuente de verdad del modelo de datos.
- `backend/routes/`: Lógica de API.
