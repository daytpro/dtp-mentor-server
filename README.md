# dtp-mentor-server

© Josué Morales Carmona · DayTraderProfesional (DTP)

Servidor de **DTP Mentor**: recibe lo que hace cada alumno en NinjaTrader (solo lectura), reconstruye sus operaciones y da al panel de mentor (Base44) las estadísticas.

Fase 1: ingesta, deduplicación, reconstrucción de operaciones, estadísticas y cuadre.
Fase 2: reglas de conducta (revancha, exceso de contratos, promediar en contra, stop alejado, 3 pérdidas seguidas) y avisos a Discord.

## Piezas

| Ruta | Quién | Qué |
|---|---|---|
| `POST /v1/consent` | AddOn | El alumno acepta, pausa o retira el envío y elige qué cuentas comparte |
| `POST /v1/heartbeat` | AddOn | Latido; devuelve el consentimiento vigente y las cuentas a enviar |
| `POST /v1/ingest` | AddOn | Lote del protocolo v1 (`src/protocol.js`), JSON o gzip |
| `GET /admin/students` | Base44 | Lista de alumnos con consentimiento y último latido |
| `GET /admin/overview?day=&tz=` | Base44 | Vista general del día: P&L, posiciones abiertas, cuadre |
| `GET /admin/students/<email>/summary?from=&to=&tz=` | Base44 | Ficha: estadísticas, curva, horas, instrumentos |
| `GET /admin/students/<email>/trades?from=&to=` | Base44 | Lista de operaciones |
| `GET /admin/alerts?since=&email=&limit=` | Base44 | Alertas de conducta y de consentimiento |
| `GET /health` | — | Salud |

- **AddOn:** cabeceras `Authorization: Bearer <token de licencia DTP>` y `X-Machine-Id`. El token lo firma el servidor de licencias; aquí solo se verifica con la **clave pública**.
- **Base44:** cabecera `x-admin-secret`, llamada solo desde funciones de servidor de Base44 (nunca desde el navegador).

## Reglas que cumple

- Una operación termina cuando **las ejecuciones** devuelven la posición a 0 (no el aviso de posición).
- Cada ejecución se guarda una sola vez (cuenta + `exec_id`). Reenviar un lote no duplica nada.
- Solo se guardan las cuentas que el alumno comparte en su consentimiento vigente. Si pausa, no se guarda nada.
- Todas las horas en UTC con zona explícita; las horas sin zona se rechazan.
- Día de sesión CME: cambia a las 17:00 de Nueva York.
- Sin valor del punto conocido no se inventa un P&L.

## Variables de entorno (Railway)

| Variable | Valor |
|---|---|
| `DATABASE_URL` | Referencia al Postgres **propio** de este servicio: `${{Postgres.DATABASE_URL}}` |
| `LICENSE_PUBLIC_KEY` | La clave pública del servidor de licencias (`GET /public-key`). No es secreta |
| `MENTOR_PRODUCT_CODE` | El código del producto DTP Mentor en los accesos de Base44 |
| `MENTOR_ADMIN_SECRET` | Secreto largo aleatorio (mín. 24), el mismo que en los secrets de Base44 |

| `DISCORD_WEBHOOK_URL` | Webhook del canal de Discord del mentor (secreto). Sin él, las alertas se guardan y se ven en el panel |
| `DISCORD_WEBHOOK_URGENT` | Opcional: otro canal solo para urgentes y pausas |

Railway asigna `PORT`.

## Reglas (sin plan del alumno)

| Regla | Cuándo | Nivel |
|---|---|---|
| Revancha | Entra < 2 min después de cerrar en pérdida | Importante |
| Exceso de contratos | Más de 2 × su mediana de las últimas 20 operaciones (con 5 de referencia) | Importante |
| Revancha + exceso | Las dos en la misma operación | **Urgente** |
| Promediar en contra | Añade contratos con la operación en pérdida | Importante |
| Stop movido en contra | Aleja el stop de protección con la posición abierta | Importante |
| Racha | 3 pérdidas seguidas en el día | Importante |
| Pausa / reanudar / retirar | Cambio de consentimiento (con el motivo) | Aviso al momento |

Urgentes y consentimiento: al momento. Importantes: resumen cada hora en punto (Madrid). Solo datos en directo de las últimas 6 h.

## Pruebas

```bash
TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/base_de_pruebas npm test
```

La base de pruebas **se vacía**: nunca usar la de producción. Sin `TEST_DATABASE_URL` solo se ejecutan las pruebas del núcleo.

Los datos de `test/fixtures/` son una prueba real de la sonda (11 nov 2026) con las cuentas anonimizadas.
