# Choferes Argentinos

Prototipo inicial de la comunidad privada de camioneros.

## Estado

Esta primera entrega es una PWA de demostración. Todavía no incluye backend compartido, cuentas reales, persistencia entre dispositivos ni notificaciones reales.

## Principios

- Comunidad privada.
- Perfiles y muro social.
- Sección de ruta con estados y avisos fechados.
- No solicitar DNI, teléfono ni correo para crear un perfil de demostración.
- Mantener el proyecto separado de ILOX y PDA // ZONA.

## Publicación

Preparado para desplegar como sitio estático cuando se incorporen los archivos de la interfaz.

## Instalación en Android

La PWA incluye manifest, iconos de aplicación y service worker. Abrir el sitio con Chrome y elegir «Instalar aplicación» cuando el navegador lo ofrezca.


## Videos cortos (plan gratuito)

- Los videos MP4 se guardan en Cloudflare Workers KV, no en R2.
- Límite por video: 15 MB, 15 segundos y resolución máxima 720p.
- Límite de la aplicación: 850 MB en producción y 25 MB en preview. Ambos usan el mismo namespace gratuito.
- Workers KV Free incluye 1 GB de almacenamiento por cuenta, 100.000 lecturas por día y 1.000 escrituras por día. Al superar los límites del plan Free, las operaciones fallan; no se habilita facturación por exceso.
- Antes del despliegue hay que crear un namespace KV gratuito y reemplazar `REPLACE_WITH_KV_NAMESPACE_ID` por su ID en las dos secciones del binding. No activar Workers Paid ni R2.
