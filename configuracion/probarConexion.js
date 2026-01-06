const { probarConexion } = require('./conexionBaseDatos');

(async () => {
    const resultado = await probarConexion();
    if (resultado.exito) {
        console.log(`${resultado.mensaje}. Fecha del servidor: ${resultado.fecha}`);
    } else {
        console.error(`${resultado.mensaje}. Detalle: ${resultado.detalle}`);
        process.exitCode = 1;
    }
})();