# Backend independiente — Choferes Argentinos

Este directorio prepara una API propia para Choferes Argentinos con **Cloudflare Workers Free + D1 Free**. Está aislado en la rama `cloudflare-backend-prep`; no modifica `main`, no cambia el sitio publicado y no toca ILOX ni PDA // ZONA.

## Decisiones de costo

- Workers Free: hasta 100.000 solicitudes por día y 10 ms de CPU por invocación.
- D1 Free: 5 millones de filas leídas por día, 100.000 filas escritas por día, 5 GB de almacenamiento total por cuenta y 500 MB por base.
- No se usa Workers Paid, KV, Images, Stream ni almacenamiento R2 Infrequent Access.
- Las fotos siguen en D1, comprimidas en el teléfono y limitadas a 1 MB.
- Los videos se guardan en R2 Standard privado: máximo 15 segundos, MP4, 720p y 15 MB por archivo. R2 incluye mensualmente 10 GB-mes, 1 millón de operaciones Clase A, 10 millones Clase B y transferencia saliente gratuita. El uso por encima de esos cupos se cobra; el nivel gratuito no es un tope de facturación.
- Para limitar el riesgo, la aplicación reserva hasta 8 GB para producción y 250 MB para preview. El cupo gratuito es compartido por toda la cuenta Cloudflare; revisar el consumo total antes de habilitarlo.
- Al superar los topes gratuitos de Workers/D1, las operaciones dejan de responder hasta el reinicio del cupo o hasta una actualización manual. No se debe actualizar el plan para resolverlo sin autorización expresa.

Fuentes oficiales consultadas el 17-11-2026:
- Workers: https://developers.cloudflare.com/workers/platform/limits/
- D1 precios: https://developers.cloudflare.com/d1/platform/pricing/
- D1 límites: https://developers.cloudflare.com/d1/platform/limits/

## Componentes

- `worker.js`: API HTTP, autenticación por token aleatorio de dispositivo, invitaciones de comunidad/amistad, vinculación de otro teléfono, muro con moderación previa, fotos y videos cortos privados, reacciones, comentarios, estados y alertas de ruta, mensajes privados y notificaciones Web Push para owner/moderator.
- `migrations/0001_initial.sql`: esquema inicial e índices.\n- `migrations/0002_moderation_and_push.sql`: estados de moderación y suscripciones de notificaciones.
- `wrangler.toml`: configuración de ejemplo. El `database_id` es deliberadamente un marcador y debe reemplazarse después de crear D1.

## Seguridad y privacidad

- No se solicitan DNI, teléfono, correo ni agenda de contactos.
- Los tokens de sesión se generan aleatoriamente; solo se almacena su hash SHA-256.
- Los códigos de invitación se guardan como hash y se consumen con límite de usos y vencimiento.
- Las consultas de muro, ruta, imágenes y mensajes se restringen a la comunidad del perfil autenticado.
- Los mensajes privados requieren que ambos perfiles estén vinculados como compañeros.
- `SETUP_SECRET` es un secreto temporal para inicializar una sola vez la comunidad. No se escribe en GitHub. Después de inicializar, hay que eliminarlo del Worker.
- `APP_ORIGIN` limita CORS al sitio publicado.


## Moderación y alertas urgentes

- Las publicaciones nuevas de miembros se guardan como `pending` y no aparecen en el muro hasta que un `owner` o `moderator` las apruebe.
- Owner/moderator pueden publicar directamente; la cola de moderación muestra las publicaciones de los miembros, con acciones aprobar/rechazar.
- Al crear una publicación pendiente, el Worker envía Web Push a los dispositivos suscriptos de owner/moderator, con urgencia alta, vibración y una notificación persistente.
- La PWA reproduce además una alarma fuerte cuando está abierta y recibe el aviso. En segundo plano o con la app cerrada, Android/Chrome controla el sonido de la notificación; la aplicación no puede imponer un tono personalizado ni saltar el modo silencio/No molestar.
- El administrador debe tocar **Activar notificaciones urgentes** una vez en cada teléfono y permitir notificaciones/sonido/vibración en Android.
- Las claves VAPID no se guardan en GitHub ni en D1. Generarlas localmente con `npx web-push generate-vapid-keys` y cargarlas como secretos en el Worker de preview: `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`. No compartir la clave privada. `VAPID_SUBJECT` es opcional; si falta, se usa el origen de la PWA como subject.
- Antes de probar, aplicar la migración `0002_moderation_and_push.sql` a la D1 de preview y desplegar el Worker de preview manualmente.

## Videos cortos del muro

- Crear los buckets privados Standard `choferes-argentinos-videos` y `choferes-argentinos-videos-preview` en Cloudflare R2.
- Mantenerlos privados; no habilitar `r2.dev`, dominio público ni acceso público. El Worker entrega videos solo a miembros autenticados de la comunidad.
- La migración `0009_post_videos.sql` guarda metadatos en D1; el archivo binario va a R2, nunca a D1.
- Preview limita los videos a 250 MB acumulados y producción a 8 GB. El cupo R2 de 10 GB-mes se comparte con toda la cuenta Cloudflare y los límites de operaciones también son mensuales. Revisar el panel de consumo antes de habilitarlo.
- Aplicar las migraciones hasta `0009_post_videos.sql` en la D1 correspondiente y desplegar el Worker con el binding R2 configurado.

## Preparación (no ejecutar hasta verificar la cuenta y el costo)

1. Crear/iniciar sesión en una cuenta Cloudflare y comprobar que el plan de Workers sea **Free**.
2. Crear la base D1 `choferes-argentinos` y copiar su ID en `wrangler.toml`.
3. Aplicar la migración `migrations/0001_initial.sql`.
4. Configurar `APP_ORIGIN` con el origen exacto del sitio de la PWA.
5. Configurar `SETUP_SECRET` como secreto (nunca como variable pública ni en GitHub).
6. Desplegar el Worker en Free y comprobar `GET /api/health`.
7. Inicializar la comunidad una sola vez mediante `POST /api/bootstrap`, guardar el token del propietario y el código inicial de invitación y eliminar `SETUP_SECRET`.
8. Integrar la PWA contra esta API en una versión de prueba. No cambiar el sitio de producción hasta verificar registro, persistencia, muro, estados, invitaciones, fotos y privacidad.

No hay despliegue ni recursos Cloudflare creados desde este repositorio. No se habilitó facturación ni se agregó un medio de pago.
