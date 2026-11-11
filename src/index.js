// © Josué Morales Carmona · DayTraderProfesional (DTP)
// dtp-mentor-server — arranque
import { migrate } from "./db.js";
import { publicKey } from "./auth.js";
import { createServer } from "./app.js";

const PORT = Number(process.env.PORT || 3000);

await migrate();
await publicKey();   // falla al arrancar si LICENSE_PUBLIC_KEY está mal
if ((process.env.MENTOR_ADMIN_SECRET || "").length < 24) console.warn("AVISO: MENTOR_ADMIN_SECRET no configurado o corto (mín. 24). /admin desactivado.");
if (!process.env.MENTOR_PRODUCT_CODE) console.warn("AVISO: MENTOR_PRODUCT_CODE no configurado. Ningún AddOn podrá enviar.");
createServer().listen(PORT, () => console.log(`dtp-mentor-server escuchando en :${PORT}`));
