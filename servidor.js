const path = require('path');
const express = require('express');
const { obtenerPool, probarConexion } = require('./configuracion/conexionBaseDatos');

const app = express();
const puerto = Number(process.env.PUERTO_APP) || 3000;

app.use(express.json());

// Habilita CORS simple para permitir llamadas desde orígenes como Live Server (puerto 5500).
app.use((solicitud, respuesta, siguiente) => {
    respuesta.header('Access-Control-Allow-Origin', '*');
    respuesta.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    respuesta.header('Access-Control-Allow-Headers', 'Content-Type');

    if (solicitud.method === 'OPTIONS') {
        return respuesta.sendStatus(204);
    }

    siguiente();
});

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
 * Permite consultar rápidamente si la base de datos responde.
 */
app.get('/api/estado-bd', async (_solicitud, respuesta) => {
    const estado = await probarConexion();

    if (!estado.exito) {
        return respuesta.status(503).json({
            exito: false,
            mensaje: estado.mensaje,
            detalle: estado.detalle
        });
    }

    respuesta.json({
        exito: true,
        mensaje: estado.mensaje,
        fecha: estado.fecha
    });
});

/**
 * Valida las credenciales contra la tabla usuarios usando columnas correo y contrasena.
 * Devuelve los datos básicos del usuario autenticado para mostrar en el cliente si se requiere.
 */
app.post('/api/autenticacion', async (solicitud, respuesta) => {
    const { correo, contrasena } = solicitud.body || {};
    const pool = obtenerPool();

    if (!correo || !contrasena) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar el correo y la contraseña.'
        });
    }

    try {
        // Obtiene el registro y usa la clave almacenada sin asumir un nombre de columna específico.
        const consulta = `
            SELECT *
            FROM usuarios
            WHERE correo = $1
            LIMIT 1
        `;
        const { rows } = await pool.query(consulta, [correo]);
        if (rows.length === 0) {
            return respuesta.status(401).json({
                exito: false,
                mensaje: 'Credenciales incorrectas, verifique sus datos.'
            });
        }

        const usuario = rows[0];
        const claveRegistrada = usuario.contrasena ?? usuario.password_hash;

        if (!claveRegistrada || claveRegistrada !== contrasena) {
            return respuesta.status(401).json({
                exito: false,
                mensaje: 'Credenciales incorrectas, verifique sus datos.'
            });
        }

        respuesta.json({
            exito: true,
            usuario: {
                id: usuario.id_usuario ?? usuario.id,
                correo: usuario.correo,
                nombre_completo: usuario.nombre_completo ?? usuario.usuario ?? usuario.correo,
                rol: usuario.rol ?? 'usuario'
            }
        });
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