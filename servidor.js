const path = require('path');
const express = require('express');
const { obtenerPool } = require('./configuracion/conexionBaseDatos');

const app = express();
const puerto = Number(process.env.PUERTO_APP) || 3000;

app.use(express.json());

// Sirve los archivos estáticos existentes para mantener la página disponible.
app.use(express.static(path.join(__dirname)));

/**
 * Obtiene los documentos almacenados en la base de datos filtrando por tipo si corresponde.
 * Se espera que la tabla documentos contenga las columnas: id, titulo, descripcion, url y tipo.
 */
app.get('/api/documentos', async (solicitud, respuesta) => {
    const tipo = solicitud.query.tipo || 'unidades';
    const pool = obtenerPool();

    try {
        const consulta = `
            SELECT id, titulo, descripcion, url, tipo
            FROM documentos
            WHERE ($1::text IS NULL OR tipo = $1)
            ORDER BY titulo ASC
        `;
        const { rows } = await pool.query(consulta, [tipo]);
        respuesta.json({ exito: true, documentos: rows });
    } catch (error) {
        console.error('Error al obtener documentos:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudieron obtener los documentos, intente nuevamente.',
            detalle: error.message
        });
    }
});

/**
 * Valida las credenciales contra la tabla usuarios usando columnas usuario y contrasena.
 * Devuelve los datos básicos del usuario autenticado para mostrar en el cliente si se requiere.
 */
app.post('/api/autenticacion', async (solicitud, respuesta) => {
    const { usuario, contrasena } = solicitud.body || {};
    const pool = obtenerPool();

    if (!usuario || !contrasena) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar el usuario y la contraseña.'
        });
    }

    try {
        const consulta = `
            SELECT id, usuario, nombre_completo, rol
            FROM usuarios
            WHERE usuario = $1 AND contrasena = $2
            LIMIT 1
        `;
        const { rows } = await pool.query(consulta, [usuario, contrasena]);

        if (rows.length === 0) {
            return respuesta.status(401).json({
                exito: false,
                mensaje: 'Credenciales incorrectas, verifique sus datos.'
            });
        }

        respuesta.json({ exito: true, usuario: rows[0] });
    } catch (error) {
        console.error('Error al autenticar usuario:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'Ocurrió un problema al validar las credenciales.',
            detalle: error.message
        });
    }
});

app.listen(puerto, () => {
    console.log(`Servidor iniciado en http://localhost:${puerto}`);
});