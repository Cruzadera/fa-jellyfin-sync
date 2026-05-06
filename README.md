# fa-jellyfin-sync
Worker que consume la API del proyecto principal para procesar/propagar ratings (migración desde scheduler local).

Resumen
- Este servicio es un worker/microservicio que consulta items a procesar y llama el endpoint `POST /ratings/batch` de la API principal.
- Autenticación: API Key (cabecera `Authorization: ApiKey <KEY>`).
- Diseñado para ejecutarse en Docker / Docker Compose y en CI.

Variables de entorno (mínimas)
- API_BASE_URL  — URL base de la API (p.ej. `http://app:8085`)
- API_KEY       — API key para autenticar las peticiones
- POLL_INTERVAL — Intervalo en segundos para hacer polling (default: 60)
- BATCH_SIZE    — Tamaño máximo del batch (default: 50)
- LOG_LEVEL     — Nivel de logs (info, debug, warn; default: info)

Ejemplo local (desarrollo)
```bash
# instalar dependencias
npm ci

# ejecutar (override envs si quieres)
API_BASE_URL=http://localhost:8085 API_KEY=secret POLL_INTERVAL=30 npm start