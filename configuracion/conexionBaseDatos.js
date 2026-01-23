const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const urlSupabase = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
const hayConfiguracionBaseDatos = () => Boolean(
    urlSupabase
    || process.env.PG_HOST
    || process.env.PG_DATABASE
    || process.env.PG_USER
    || process.env.PG_PASSWORD
    || process.env.PG_PORT
);
const usarSSL = (process.env.PG_SSL || '').toLowerCase() === 'true'
    || Boolean(urlSupabase)
    || Boolean(process.env.VERCEL);

let pool = null;

if (!(process.env.VERCEL && !hayConfiguracionBaseDatos())) {
    const configuracionConexion = {
        ...(urlSupabase
            ? { connectionString: urlSupabase }
            : {
                host: process.env.PG_HOST || 'localhost',
                port: Number(process.env.PG_PORT) || 5432,
                database: process.env.PG_DATABASE || 'JJPalacios',
                user: process.env.PG_USER || 'postgres',
                password: process.env.PG_PASSWORD || 'admin'
            }),
        // Supabase exige TLS en conexiones externas, por eso se habilita SSL automáticamente.
        ssl: usarSSL ? { rejectUnauthorized: false } : false,
        max: Number(process.env.PG_POOL_MAX) || 10,
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT) || 30000
    };

    pool = new Pool(configuracionConexion);
}

/**
 * Devuelve el pool configurado para reutilizar conexiones en toda la aplicación.
 */
function obtenerPool() {
    return pool;
}

/**
 * Ejecuta una consulta sencilla para validar la conexión con la base de datos.
 * Regresa un objeto con la información de éxito o el motivo de la falla.
 */
async function probarConexion() {
    if (!pool) {
        return {
            exito: false,
            mensaje: 'No hay configuración disponible para conectar con PostgreSQL.',
            detalle: 'Configure SUPABASE_DB_URL o las variables PG_* en el entorno.'
        };
    }

    let cliente;

    try {
        cliente = await pool.connect();
        const resultado = await cliente.query('SELECT NOW() AS fecha_actual');
        const fechaActual = resultado.rows?.[0]?.fecha_actual;

        return {
            exito: true,
            mensaje: 'Conexión a PostgreSQL exitosa',
            fecha: fechaActual
        };
    } catch (error) {
        return {
            exito: false,
            mensaje: 'No se pudo establecer la conexión con PostgreSQL',
            detalle: error.message
        };
    } finally {
        if (cliente) {
            cliente.release();
        }
    }
}

module.exports = {
    obtenerPool,
    probarConexion,
    hayConfiguracionBaseDatos
};
