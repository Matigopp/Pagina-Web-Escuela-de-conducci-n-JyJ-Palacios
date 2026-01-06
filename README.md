# Pagina-Web-Escuela-de-conducci-n-JyJ-Palacios

## Conexión a PostgreSQL

La configuración predeterminada usa estos datos:
- Host: `localhost`
- Puerto: `5432`
- Base de datos: `JJPalacios`
- Usuario: `postgres`
- Contraseña: `admin`

Pasos sugeridos:
1. Copia el archivo `.env.example` a `.env` y ajusta los valores si es necesario.
2. Instala las dependencias para la conexión: `npm install`.
3. Valida la conexión con el comando: `npm run probar:conexion`.

El archivo `configuracion/conexionBaseDatos.js` crea un pool de conexiones reutilizable y expone la función `probarConexion` para verificar rápidamente que el acceso a la base de datos esté disponible.