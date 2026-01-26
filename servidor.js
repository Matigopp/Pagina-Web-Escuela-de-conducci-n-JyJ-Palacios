const path = require('path');
const express = require('express');
const { obtenerPool, probarConexion, hayConfiguracionBaseDatos } = require('./configuracion/conexionBaseDatos');
const supabase = require("./configuracion/supabaseClient");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Sirve todos los archivos estáticos desde la raíz del proyecto
app.use(express.static(path.join(__dirname, "public")));

// Home
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const puerto = Number(process.env.PUERTO_APP) || 3000;

// Detecta si el proceso corre dentro del entorno de Vercel.
function estaEnVercel() {
    return Boolean(process.env.VERCEL);
}

// Verifica si existe alguna variable de entorno con la configuración de la base de datos.
const hayConfiguracionBaseDatosEnEntorno = hayConfiguracionBaseDatos();

/**
 * Obtiene las columnas disponibles en la tabla usuarios para mantener compatibilidad
 * con diferentes versiones del esquema.
 */

async function obtenerColumnasUsuarios(pool) {
    const consulta = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'usuarios'
    `;
    const { rows } = await pool.query(consulta);
    return new Set(rows.map((fila) => fila.column_name));
}

/**
 * Asegura la columna nombre y la restricción que impide números en el nombre.
 */
async function asegurarColumnaNombre(pool) {
    const columnas = await obtenerColumnasUsuarios(pool);

    if (!columnas.has('nombre')) {
        await pool.query('ALTER TABLE usuarios ADD COLUMN nombre TEXT');

        if (columnas.has('nombre_completo')) {
            await pool.query('UPDATE usuarios SET nombre = nombre_completo WHERE nombre IS NULL');
        } else if (columnas.has('usuario')) {
            await pool.query('UPDATE usuarios SET nombre = usuario WHERE nombre IS NULL');
        }
    }

    const restriccion = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'usuarios'
          AND constraint_name = 'usuarios_nombre_solo_texto'
    `);

    if (restriccion.rows.length === 0) {
        await pool.query(`
            ALTER TABLE usuarios
            ADD CONSTRAINT usuarios_nombre_solo_texto
            CHECK (nombre !~ '[0-9]')
        `);
    }
}

/**
 * Asegura que la columna de ID tenga una secuencia asociada para autoincrementar.
 * Se crea la secuencia si no existe y se sincroniza con el máximo ID registrado.
 */
async function asegurarSecuenciaUsuarios(pool) {
    const { columnaId } = await obtenerMapaUsuarios(pool);
    const nombreSecuencia = `usuarios_${columnaId}_seq`;

    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${nombreSecuencia}`);
    await pool.query(`
        ALTER TABLE usuarios
        ALTER COLUMN ${columnaId}
        SET DEFAULT nextval('${nombreSecuencia}')
    `);
    await pool.query(`
        SELECT setval(
            '${nombreSecuencia}',
            COALESCE((SELECT MAX(${columnaId}) FROM usuarios), 0)
        )
    `);
}

/**
 * Define el mapeo de columnas esperadas según el esquema disponible.
 */
async function obtenerMapaUsuarios(pool) {
    const columnas = await obtenerColumnasUsuarios(pool);

    return {
        columnaId: columnas.has('id_usuario') ? 'id_usuario' : 'id',
        columnaNombre: columnas.has('nombre')
            ? 'nombre'
            : columnas.has('nombre_completo')
                ? 'nombre_completo'
                : 'usuario',
        columnaCorreo: columnas.has('correo') ? 'correo' : columnas.has('usuario') ? 'usuario' : null,
        columnaContrasena: columnas.has('contrasena') ? 'contrasena' : 'password_hash'
    };
}

function nombreContieneNumeros(nombre) {
    return /[0-9]/.test(nombre);
}

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

const pool = obtenerPool();
// En serverless evitamos tareas pesadas en el arranque para reducir errores en Vercel.
const debePrepararBaseDatos = !estaEnVercel() && hayConfiguracionBaseDatosEnEntorno;

if (debePrepararBaseDatos) {
    if (!pool) {
        console.warn('No se pudo preparar la base de datos porque no hay un pool disponible.');
    } else {
        asegurarColumnaNombre(pool).catch((error) => {
            console.error('No se pudo preparar la columna nombre en usuarios:', error);
        });
        asegurarSecuenciaUsuarios(pool).catch((error) => {
            console.error('No se pudo preparar la secuencia de usuarios:', error);
        });
    }
} else if (!estaEnVercel()) {
    console.warn('Se omitió la preparación de la base de datos porque no hay configuración disponible.');
}

function obtenerPoolParaSolicitud(respuesta) {
    const pool = obtenerPool();

    if (!pool) {
        respuesta.status(503).json({
            exito: false,
            mensaje: 'No hay configuración de base de datos disponible en este entorno.'
        });
        return null;
    }

    return pool;
}


/**
 * Obtiene los documentos almacenados en la base de datos filtrando por tipo si corresponde.
 * Se mapea la estructura de la API (id, titulo, descripcion, url, tipo) a la tabla documentos:
 * id_documento, titulo_documento, descripcion_documento, documento, tipo_documento.
 */
app.get('/api/documentos', async (solicitud, respuesta) => {
    const tipo = solicitud.query.tipo || 'unidades';
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

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
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

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
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

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
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

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
 * Obtiene todos los usuarios registrados.
 * Se asume la tabla usuarios con columnas: id_usuario, nombre_completo, correo, contraseña
 */
app.get('/api/usuarios', async (_solicitud, respuesta) => {
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

    try {
        const {
            columnaId,
            columnaNombre,
            columnaCorreo,
            columnaContrasena
        } = await obtenerMapaUsuarios(pool);
        const consulta = `
            SELECT ${columnaId} AS id,
                   ${columnaNombre} AS nombre,
                   ${columnaCorreo ? `${columnaCorreo} AS correo` : "NULL::text AS correo"},
                   ${columnaContrasena} AS contrasena
            FROM usuarios
            ORDER BY ${columnaNombre} ASC
        `;
        const { rows } = await pool.query(consulta);
        respuesta.json({ exito: true, usuarios: rows });
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudieron obtener los usuarios, intente nuevamente.',
            detalle: error.message
        });
    }
});

/**
 * Registra un usuario en la base de datos.
 */
app.post('/api/usuarios', async (solicitud, respuesta) => {
    const { nombre, correo, contrasena } = solicitud.body || {};
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

    if (!nombre || !correo || !contrasena) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar nombre, correo y contraseña.'
        });
    }

    if (nombreContieneNumeros(nombre)) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'El nombre no puede contener números.'
        });
    }

    try {
        const {
            columnaId,
            columnaNombre,
            columnaCorreo
        } = await obtenerMapaUsuarios(pool);

        const columnaCorreoUsada = columnaCorreo || 'correo';
        // Valida el correo antes de insertar para evitar consumir un ID si existe un duplicado.
        const consultaExistente = `
            SELECT 1
            FROM usuarios
            WHERE ${columnaCorreoUsada} = $1
            LIMIT 1
        `;
        const { rows: coincidencias } = await pool.query(consultaExistente, [correo]);

        if (coincidencias.length > 0) {
            return respuesta.status(409).json({
                exito: false,
                mensaje: 'El correo ya está registrado.'
            });
        }
        const consulta = `
            INSERT INTO usuarios (${columnaNombre}, ${columnaCorreoUsada}, contrasena)
            VALUES ($1, $2, $3)
            RETURNING ${columnaId} AS id,
                      ${columnaNombre} AS nombre,
                      ${columnaCorreoUsada} AS correo
        `;
        const { rows } = await pool.query(consulta, [nombre, correo, contrasena]);
        respuesta.status(201).json({
            exito: true,
            usuario: rows[0]
        });
    } catch (error) {
        console.error('Error al crear usuario:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudo crear el usuario, intente nuevamente.',
            detalle: error.message
        });
    }
});

/**
 * Actualiza un usuario existente.
 * Si no se envía contraseña, se conserva la clave registrada actualmente.
 */
app.put('/api/usuarios/:id', async (solicitud, respuesta) => {
    const { id } = solicitud.params;
    const { nombre, correo, contrasena } = solicitud.body || {};
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

    if (!id || !nombre || !correo) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar ID, nombre y correo.'
        });
    }

    if (nombreContieneNumeros(nombre)) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'El nombre no puede contener números.'
        });
    }

    try {
        const {
            columnaId,
            columnaNombre,
            columnaCorreo
        } = await obtenerMapaUsuarios(pool);

        const columnaCorreoUsada = columnaCorreo || 'correo';
        const consulta = `
            UPDATE usuarios
            SET ${columnaNombre} = $1,
                ${columnaCorreoUsada} = $2,
                contrasena = COALESCE($3, contrasena)
            WHERE ${columnaId} = $4
            RETURNING ${columnaId} AS id,
                      ${columnaNombre} AS nombre,
                      ${columnaCorreoUsada} AS correo
        `;
        const { rows } = await pool.query(consulta, [nombre, correo, contrasena || null, id]);

        if (rows.length === 0) {
            return respuesta.status(404).json({
                exito: false,
                mensaje: 'No se encontró el usuario solicitado.'
            });
        }

        respuesta.json({ exito: true, usuario: rows[0] });
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudo actualizar el usuario, intente nuevamente.',
            detalle: error.message
        });
    }
});

/**
 * Elimina un usuario por su ID.
 */
app.delete('/api/usuarios/:id', async (solicitud, respuesta) => {
    const { id } = solicitud.params;
    const pool = obtenerPoolParaSolicitud(respuesta);

    if (!pool) {
        return;
    }

    if (!id) {
        return respuesta.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar el ID del usuario.'
        });
    }

    try {
        const { columnaId } = await obtenerMapaUsuarios(pool);
        const nombreSecuencia = `usuarios_${columnaId}_seq`;
        const cliente = await pool.connect();

        try {
            await cliente.query('BEGIN');
            const consulta = `
                DELETE FROM usuarios
                WHERE ${columnaId} = $1
                RETURNING ${columnaId} AS id
            `;
            const { rows } = await cliente.query(consulta, [id]);

            if (rows.length === 0) {
                await cliente.query('ROLLBACK');
                return respuesta.status(404).json({
                    exito: false,
                    mensaje: 'No se encontró el usuario solicitado.'
                });
            }

            // Mantiene la numeración continua al compactar IDs posteriores al eliminado.
            await cliente.query(`
                UPDATE usuarios
                SET ${columnaId} = ${columnaId} - 1
                WHERE ${columnaId} > $1
            `, [id]);
            await cliente.query(`
                SELECT setval(
                    '${nombreSecuencia}',
                    COALESCE((SELECT MAX(${columnaId}) FROM usuarios), 0)
                )
            `);
            await cliente.query('COMMIT');
            respuesta.json({ exito: true });
        } catch (error) {
            await cliente.query('ROLLBACK');
            throw error;
        } finally {
            cliente.release();
        }

    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        respuesta.status(500).json({
            exito: false,
            mensaje: 'No se pudo eliminar el usuario, intente nuevamente.',
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

app.post('/api/autenticacion', async (req, res) => {
    const { correo, contrasena, password } = req.body || {};
    const clave = contrasena || password;

    if (!correo || !clave) {
        return res.status(400).json({
            exito: false,
            mensaje: 'Debe proporcionar el correo y la contraseña.'
        });
    }

    try {
        // Trae solo las columnas reales de la tabla usuarios.
        const { data: usuario, error } = await supabase
            .from('usuarios')
            .select('id_usuario, nombre, correo, contrasena')
            .eq('correo', correo)
            .maybeSingle();


        if (error) {
            console.error('Supabase error /api/autenticacion:', error);
            return res.status(500).json({
                exito: false,
                mensaje: 'No se pudo validar el acceso en Supabase.',
                detalle: error.message
            });
        }

        if (!usuario) {
            return res.status(401).json({
                exito: false,
                mensaje: 'Credenciales incorrectas, verifique sus datos.'
            });
        }

        // Comparación simple en texto plano. Si luego se usa hash, se cambia aquí.
        if ((usuario.contrasena || '').trim() !== String(clave).trim()) {
            return res.status(401).json({
                exito: false,
                mensaje: 'Credenciales incorrectas, verifique sus datos.'
            });
        }

        return res.json({
            exito: true,
            usuario: {
                id: usuario.id_usuario,
                correo: usuario.correo,
                nombre_completo: usuario.nombre || usuario.correo
            }
        });
    } catch (e) {
        console.error('Error interno /api/autenticacion:', e);
        return res.status(500).json({
            exito: false,
            mensaje: 'Ocurrió un problema al validar las credenciales.',
            detalle: String(e.message || e)
        });
    }
});

/**
 * Diagnóstico rápido de conexión con Supabase.
 * Útil para distinguir problemas de credenciales, RLS o tabla inexistente.
 */
app.get('/api/diag/supabase', async (_req, res) => {
    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('correo')
            .limit(1);

        if (error) {
            return res.status(500).json({ ok: false, error: error.message });
        }

        return res.json({ ok: true, sample: data });
    } catch (e) {
        return res.status(500).json({ ok: false, error: String(e) });
    }
});


if (!estaEnVercel()) {
    app.listen(puerto, () => {
        console.log(`Servidor iniciado en http://localhost:${puerto}`);
    });
}

// Exporta la app para que Vercel la ejecute como función serverless.
module.exports = app;
