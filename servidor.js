const path = require('path');
const express = require('express');
const multer = require('multer');
const { obtenerPool, probarConexion, hayConfiguracionBaseDatos } = require('./configuracion/conexionBaseDatos');
const { obtenerClienteSupabase } = require("./configuracion/supabaseClient");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Aplica el middleware de carga solo cuando el request es multipart/form-data.
function procesarArchivoSiEsMultipart(req, res, next) {
    const tipoContenido = req.headers['content-type'] || '';
    if (tipoContenido.startsWith('multipart/form-data')) {
        return upload.single('archivo')(req, res, next);
    }
    return next();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Sirve todos los archivos estáticos desde la raíz del proyecto
app.use(express.static(path.join(__dirname, "public")));

// Home
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Expone solo las claves públicas necesarias para inicializar Supabase en el navegador.
app.get("/api/configuracion-publica", (_req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
        return res.status(500).json({
            exito: false,
            mensaje: "Faltan SUPABASE_URL o SUPABASE_ANON_KEY en el entorno."
        });
    }

    return res.json({
        exito: true,
        supabaseUrl,
        supabaseAnonKey
    });
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

// Aumenta el límite del cuerpo para permitir formularios y solicitudes JSON extensas.
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

function obtenerSupabaseParaSolicitud(respuesta) {
    const { cliente, error } = obtenerClienteSupabase();

    if (!cliente) {
        // Responde con un mensaje claro cuando falta configuración en el entorno.
        respuesta.status(503).json({
            exito: false,
            mensaje: error || 'No hay configuración de Supabase disponible en este entorno.'
        });
        return null;
    }

    return cliente;
}

async function buscarUsuarioPorCorreoConPool(pool, correo) {
    const mapa = await obtenerMapaUsuarios(pool);

    if (!mapa.columnaCorreo || !mapa.columnaContrasena) {
        return {
            usuario: null,
            error: 'No se pudo identificar las columnas de correo y contraseña en la tabla usuarios.'
        };
    }

    const consulta = `
        SELECT
            ${mapa.columnaId} AS id_usuario,
            ${mapa.columnaNombre} AS nombre,
            ${mapa.columnaCorreo} AS correo,
            ${mapa.columnaContrasena} AS contrasena
        FROM usuarios
        WHERE ${mapa.columnaCorreo} = $1
        LIMIT 1
    `;

    const { rows } = await pool.query(consulta, [correo]);
    return { usuario: rows[0] || null, error: null };
}

// LISTAR DOCUMENTOS (opcionalmente por tipo)
app.get("/api/documentos", async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        const tipo = (req.query.tipo || "").toString().trim();

        let q = supabase
            .from("documentos")
            .select("id_documento, titulo_documento, descripcion_documento, documento, tipo_documento")
            .order("id_documento", { ascending: true });

        if (tipo) {
            q = q.eq("tipo_documento", tipo);
        }

        const { data, error } = await q;
        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true, documentos: data });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// CREAR DOCUMENTO
app.post("/api/documentos", upload.single("archivo"), async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const { titulo_documento, descripcion_documento, tipo_documento } = req.body || {};
        const archivo = req.file;
        if (!titulo_documento || !tipo_documento || !archivo) {
            return res.status(400).json({ exito: false, mensaje: "Faltan campos obligatorios." });
        }

        // Genera un nombre único para el archivo en Storage.
        const nombreSeguro = archivo.originalname.replace(/[^\w.\-]+/g, "_");
        const ruta = `${Date.now()}_${nombreSeguro}`;

        // Sube el archivo a Supabase Storage.
        const { error: errorSubida } = await supabase.storage
            .from("documentos")
            .upload(ruta, archivo.buffer, { contentType: archivo.mimetype, upsert: false });

        if (errorSubida) {
            return res.status(500).json({ exito: false, mensaje: errorSubida.message });
        }

        // Obtiene la URL pública cuando el bucket es público.
        const { data: datosPublicos } = supabase.storage.from("documentos").getPublicUrl(ruta);
        const urlDocumento = datosPublicos?.publicUrl || ruta;

        const { data, error } = await supabase
            .from("documentos")
            .insert([{
                titulo_documento,
                descripcion_documento: descripcion_documento || "",
                documento: urlDocumento,
                tipo_documento
            }])
            .select("id_documento, titulo_documento, descripcion_documento, documento, tipo_documento")
            .single();

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true, documento: data });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// EDITAR DOCUMENTO
app.put("/api/documentos/:id", procesarArchivoSiEsMultipart, async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({ exito: false, mensaje: "ID inválido." });
        }

        const { titulo_documento, descripcion_documento, documento, tipo_documento } = req.body || {};
        const payload = {};
        if (titulo_documento != null) {
            payload.titulo_documento = titulo_documento;
        }
        if (descripcion_documento != null) {
            payload.descripcion_documento = descripcion_documento;
        }
        const archivo = req.file;
        if (archivo) {
            // Genera un nombre único para el nuevo archivo en Storage.
            const nombreSeguro = archivo.originalname.replace(/[^\w.\-]+/g, "_");
            const ruta = `${Date.now()}_${nombreSeguro}`;

            // Sube el archivo a Supabase Storage.
            const { error: errorSubida } = await supabase.storage
                .from("documentos")
                .upload(ruta, archivo.buffer, { contentType: archivo.mimetype, upsert: false });

            if (errorSubida) {
                return res.status(500).json({ exito: false, mensaje: errorSubida.message });
            }

            const { data: datosPublicos } = supabase.storage.from("documentos").getPublicUrl(ruta);
            payload.documento = datosPublicos?.publicUrl || ruta;
        } else if (documento != null && String(documento).trim() !== "") {
            payload.documento = documento;
        }
        if (tipo_documento != null) {
            payload.tipo_documento = tipo_documento;
        }

        const { data, error } = await supabase
            .from("documentos")
            .update(payload)
            .eq("id_documento", id)
            .select("id_documento, titulo_documento, descripcion_documento, documento, tipo_documento")
            .single();

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true, documento: data });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// ELIMINAR DOCUMENTO
app.delete("/api/documentos/:id", async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({ exito: false, mensaje: "ID inválido." });
        }

        const { error } = await supabase
            .from("documentos")
            .delete()
            .eq("id_documento", id);

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// LISTAR USUARIOS
app.get("/api/usuarios", async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const { data, error } = await supabase
            .from("usuarios")
            .select("id_usuario, nombre, correo")
            .order("id_usuario", { ascending: true });

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true, usuarios: data });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// Lee el correo enviado por el frontend para validar acciones restringidas.
function obtenerCorreoSesionDesdeHeaders(req) {
    const correoHeader = req.get("x-correo-sesion");
    if (!correoHeader) {
        return "";
    }
    return String(correoHeader).trim().toLowerCase();
}

// Valida que el correo enviado corresponda al administrador autorizado.
function validarCorreoAdministrador(req, res) {
    const correoAdmin = "admin@gmail.com";
    const correoSesion = obtenerCorreoSesionDesdeHeaders(req);
    if (correoSesion !== correoAdmin) {
        res.status(403).json({
            exito: false,
            mensaje: "No autorizado para realizar esta acción."
        });
        return false;
    }
    return true;
}

// CREAR USUARIO
app.post("/api/usuarios", async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const { nombre, correo, contrasena } = req.body || {};
        if (!nombre || !correo || !contrasena) {
            return res.status(400).json({ exito: false, mensaje: "Faltan campos obligatorios." });
        }

        const { data, error } = await supabase
            .from("usuarios")
            .insert([{ nombre, correo, contrasena }])
            .select("id_usuario, nombre, correo")
            .single();

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true, usuario: data });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// EDITAR USUARIO
app.put("/api/usuarios/:id", async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const id = Number(req.params.id);
        const { nombre, correo, contrasena } = req.body || {};
        if (!id) {
            return res.status(400).json({ exito: false, mensaje: "ID inválido." });
        }

        const payload = {};
        if (nombre != null) {
            payload.nombre = nombre;
        }
        if (correo != null) {
            payload.correo = correo;
        }
        if (contrasena != null && String(contrasena).trim() !== "") {
            payload.contrasena = contrasena;
        }

        const { data, error } = await supabase
            .from("usuarios")
            .update(payload)
            .eq("id_usuario", id)
            .select("id_usuario, nombre, correo")
            .single();

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true, usuario: data });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
    }
});

// ELIMINAR USUARIO
app.delete("/api/usuarios/:id", async (req, res) => {
    try {
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
        if (!validarCorreoAdministrador(req, res)) {
            return;
        }
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({ exito: false, mensaje: "ID inválido." });
        }

        const { error } = await supabase
            .from("usuarios")
            .delete()
            .eq("id_usuario", id);

        if (error) {
            return res.status(500).json({ exito: false, mensaje: error.message });
        }
        return res.json({ exito: true });
    } catch (e) {
        return res.status(500).json({ exito: false, mensaje: String(e) });
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
        const { cliente: supabase, error: errorSupabase } = obtenerClienteSupabase();
        let usuario = null;
        let errorConsulta = null;

        if (supabase) {
            // Trae solo las columnas reales de la tabla usuarios desde Supabase.
            const { data, error } = await supabase
                .from('usuarios')
                .select('id_usuario, nombre, correo, contrasena')
                .eq('correo', correo)
                .maybeSingle();

            if (error) {
                console.error('Supabase error /api/autenticacion:', error);
                errorConsulta = error.message || 'Error desconocido en Supabase.';
            } else {
                usuario = data;
            }
        } else {
            errorConsulta = errorSupabase || 'No hay configuración de Supabase disponible en este entorno.';
        }

        const sinSupabase = !supabase;
        const esErrorPermisos = /permission denied|rls|row level security/i.test(errorConsulta || '');

        if (!usuario && (esErrorPermisos || !supabase)) {
            const pool = obtenerPool();
            if (pool) {
                const resultado = await buscarUsuarioPorCorreoConPool(pool, correo);
                if (resultado.error) {
                    errorConsulta = resultado.error;
                } else {
                    usuario = resultado.usuario;
                }
            }
        }

        if (!usuario && errorConsulta) {
            const mensaje = esErrorPermisos
                ? 'No hay permisos para consultar usuarios en Supabase. Configure la key de servicio o ajuste RLS.'
                : 'No se pudo validar el acceso en Supabase.';
            const codigoEstado = sinSupabase ? 503 : esErrorPermisos ? 500 : 502;
            return res.status(codigoEstado).json({
                exito: false,
                mensaje,
                detalle: errorConsulta
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
        const supabase = obtenerSupabaseParaSolicitud(res);
        if (!supabase) {
            return;
        }
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
