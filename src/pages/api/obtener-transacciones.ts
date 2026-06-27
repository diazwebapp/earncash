import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const GET: APIRoute = async ({ request }) => {
  // 1. Instanciamos el objeto URL pasándole la URL completa de la petición
  const url = new URL(request.url);

  // 2. Extraemos los parámetros usando .searchParams.get('nombre_del_parametro')
  const userid = url.searchParams.get('userid');
  try {
    
    // Inyección garantizada utilizando las variables globales del proceso o import.meta
    const supabaseUrl = process.env.SUPABASE_URL || import.meta.env.SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Faltan credenciales del servidor' }), { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);


    const { data: transacciones, error: dbError } = await supabase
      .from('transacciones')
      .select('*')
      .eq('usuario_id', userid)
      .order('id', { ascending: false });

    if (dbError) throw dbError;

    return new Response(JSON.stringify({ success: true, transacciones }), { status: 200 });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};