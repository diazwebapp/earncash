import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from 'vite';

// Cargamos las variables de entorno de forma segura en el servidor
const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');

export const GET: APIRoute = async ({ request }) => {
  try {
    // 1. Obtener el token de sesión del encabezado de autorización
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    
    // 2. Inicializar Supabase con las variables cargadas
    const supabaseUrl = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Faltan las variables de entorno de Supabase en el Servidor.");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 3. Validar el usuario en Supabase con su token de acceso
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Sesión inválida o expirada.' }), { status: 401 });
    }

    // 4. Consultar las transacciones usando los nombres exactos de tu tabla
    const { data: transacciones, error: dbError } = await supabase
      .from('transacciones')
      .select('*')
      .eq('usuario_id', user.id)
      .order('id', { ascending: false }); // Usamos 'id' o la columna de fecha que tengas para ordenar

    if (dbError) throw dbError;

    return new Response(JSON.stringify({ success: true, transacciones }), { status: 200 });
  } catch (error: any) {
    console.error("❌ Error en obtener-transacciones:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};