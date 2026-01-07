const path = require('path');
const express = require('express');
const { obtenerPool, probarConexion } = require('./configuracion/conexionBaseDatos');

const app = express();
const puerto = Number(process.env.PUERTO_APP) || 3000;

// Aumenta el límite del cuerpo para permitir documentos en base64 o JSON extensos.
app.use(express.json({ limit: process.env.LIMITE_CUERPO_JSON || '20mb' }));
app.use(express.urlencoded({ limit: process.env.LIMITE_CUERPO_URL || '20mb', extended: true }));

// Habilita CORS simple para permitir llamadas desde orígenes como Live Server (puerto 5500).
app.use((solicitud, respuesta, siguiente) => {
    respuesta.header('Access-Control-Allow-Origin', '*');
    respuesta.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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
 * Se mapea la estructura de la API (id, titulo, descripcion, url, tipo) a la tabla documentos:
 * id_documento, titulo_documento, descripcion_documento, documento, tipo_documento.
 */
app.get('/api/documentos', async (solicitud, respuesta) => {
    const tipo = solicitud.query.tipo || 'unidades';
    const pool = obtenerPool();

    try {
        const consulta = `
            SELECT id_documento AS id,
                   titulo_documento AS titulo,
                   descripcion_documento AS descripcion,
                   documento AS url,
                   tipo_documento AS tipo
            FROM documentos
            WHERE ($1::text IS NULL OR tipo_documento = $1)
            ORDER BY titulo_documento ASC
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
 * Registra un documento en la base de datos.
 * documento corresponde al archivo en sí (ruta, URL o base64) enviado desde el formulario.
 */
app.post('/api/documentos', async (solicitud, respuesta) => {
    const { titulo, descripcion, url, tipo } = solicitud.body || {};
    const pool = obtenerPool();

    if (!titulo || !url || !tipo) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar título, URL y tipo del documento.'
        });
    }

    try {
        const consulta = `
            INSERT INTO documentos (titulo_documento, descripcion_documento, documento, tipo_documento)
            VALUES ($1, $2, $3, $4)
            RETURNING id_documento AS id,
                      titulo_documento AS titulo,
                      descripcion_documento AS descripcion,
                      documento AS url,
                      tipo_documento AS tipo
        `;
        const { rows } = await pool.query(consulta, [titulo, descripcion || null, url, tipo]);
        respuesta.status(201).json({ exito: true, documento: rows[0] });
    } catch (error) {
        console.error('Error al crear documento:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudo crear el documento, intente nuevamente.',
            detalle: error.message
        });
    }
});

/**
 * Actualiza un documento existente.
 */
app.put('/api/documentos/:id', async (solicitud, respuesta) => {
    const { id } = solicitud.params;
    const { titulo, descripcion, url, tipo } = solicitud.body || {};
    const pool = obtenerPool();

    if (!id || !titulo || !url || !tipo) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar ID, título, URL y tipo del documento.'
        });
    }

    try {
        const consulta = `
            UPDATE documentos
            SET titulo_documento = $1,
                descripcion_documento = $2,
                documento = $3,
                tipo_documento = $4
            WHERE id_documento = $5
            RETURNING id_documento AS id,
                      titulo_documento AS titulo,
                      descripcion_documento AS descripcion,
                      documento AS url,
                      tipo_documento AS tipo
        `;
        const { rows } = await pool.query(consulta, [titulo, descripcion || null, url, tipo, id]);

        if (rows.length === 0) {
            return respuesta.status(404).json({
                exito: false,
                mensaje: 'No se encontró el documento solicitado.'
            });
        }

        respuesta.json({ exito: true, documento: rows[0] });
    } catch (error) {
        console.error('Error al actualizar documento:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudo actualizar el documento, intente nuevamente.',
            detalle: error.message
        });
    }
});

/**
 * Elimina un documento por su ID.
 */
app.delete('/api/documentos/:id', async (solicitud, respuesta) => {
    const { id } = solicitud.params;
    const pool = obtenerPool();

    if (!id) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar el ID del documento.'
        });
    }

    try {
        const consulta = `
            DELETE FROM documentos
            WHERE id_documento = $1
            RETURNING id_documento AS id
        `;
        const { rows } = await pool.query(consulta, [id]);

        if (rows.length === 0) {
            return respuesta.status(404).json({
                exito: false,
                mensaje: 'No se encontró el documento solicitado.'
            });
        }

        respuesta.json({ exito: true });
    } catch (error) {
        console.error('Error al eliminar documento:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudo eliminar el documento, intente nuevamente.',
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