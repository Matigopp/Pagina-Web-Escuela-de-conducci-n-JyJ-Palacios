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

## Servidor y API

Para que la página consulte la base de datos y obtenga documentos o valide el ingreso, se agregó un pequeño servidor con Express.

### Puesta en marcha
1. Configura el archivo `.env` con los datos de conexión y el puerto del servidor (`PUERTO_APP`).
2. Instala dependencias: `npm install`.
3. Inicia el servidor y los recursos estáticos: `npm start`.
4. Abre `http://localhost:3000/ListaDeContenidos.html` (o el puerto configurado).

### Tablas esperadas
- `documentos`: columnas `id`, `titulo`, `descripcion`, `url`, `tipo`. El parámetro `tipo` debe tener valores como `unidades` o `material` para filtrar en el front-end.
- `usuarios`: columnas `id`, `usuario`, `contrasena`, `nombre_completo`, `rol`. Las credenciales se validan con `usuario` y `contrasena`.

### Endpoints disponibles
- `GET /api/documentos?tipo=unidades|material`: devuelve los documentos filtrados por tipo.
- `POST /api/autenticacion`: recibe `{ usuario, contrasena }` y responde con los datos básicos del usuario si las credenciales son válidas.

El archivo `configuracion/conexionBaseDatos.js` crea un pool de conexiones reutilizable y expone la función `probarConexion` para verificar rápidamente que el acceso a la base de datos esté disponible.