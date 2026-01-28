const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require("@supabase/supabase-js");

// Carga variables de entorno desde .env para entornos locales.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

let supabaseCliente = null;
let supabaseClienteAdmin = null;
let errorConfiguracion = null;
let errorConfiguracionAdmin = null;

function obtenerClienteSupabase() {
  if (supabaseCliente || errorConfiguracion) {
    return { cliente: supabaseCliente, error: errorConfiguracion };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    errorConfiguracion = "Faltan SUPABASE_URL o SUPABASE_*_KEY en variables de entorno.";
    return { cliente: null, error: errorConfiguracion };
  }

  supabaseCliente = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
  });

  return { cliente: supabaseCliente, error: null };
}

function obtenerClienteSupabaseAdmin() {
  if (supabaseClienteAdmin || errorConfiguracionAdmin) {
    return { cliente: supabaseClienteAdmin, error: errorConfiguracionAdmin };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    errorConfiguracionAdmin = "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en variables de entorno.";
    return { cliente: null, error: errorConfiguracionAdmin };
  }

  supabaseClienteAdmin = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
  });

  return { cliente: supabaseClienteAdmin, error: null };
}

module.exports = { obtenerClienteSupabase, obtenerClienteSupabaseAdmin };
