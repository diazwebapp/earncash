import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { usuarioId, address, amount } = await request.json();

    if (!usuarioId || !address || !amount || amount <= 0) {
      return new Response(JSON.stringify({ error: 'Datos de retiro inválidos.' }), { status: 400 });
    }

    // Inicializar Supabase con privilegios de Servidor
    const supabaseUrl = import.meta.env.SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Obtener el balance actual del usuario
    const { data: perfil, error: perfilError } = await supabase
      .from('perfiles')
      .select('balance_virtual')
      .eq('id', usuarioId)
      .single();

    if (perfilError || !perfil) {
      return new Response(JSON.stringify({ error: 'Usuario no encontrado.' }), { status: 404 });
    }

    const balanceActual = parseFloat(perfil.balance_virtual || "0");

    // 2. Verificar si tiene fondos suficientes
    if (balanceActual < amount) {
      return new Response(JSON.stringify({ error: 'Saldo insuficiente para realizar el retiro.' }), { status: 400 });
    }

    // 3. Restar el saldo de forma inmediata en Supabase
    const nuevoSaldo = balanceActual - amount;
    const { error: updateError } = await supabase
      .from('perfiles')
      .update({ balance_virtual: nuevoSaldo })
      .eq('id', usuarioId);

    if (updateError) throw updateError;

    // 4. Registrar la transacción en estado PENDIENTE para tu revisión manual posterior
    const { error: txError } = await supabase
      .from('transacciones')
      .insert({
        usuario_id: usuarioId,
        monto_virtual: amount,
        tipo: 'retiro',
        estado: 'pendiente', // Cambiará a 'completado' cuando envíes los USDT por blockchain
        tx_hash: `Aprobación Pendiente -> Destino: ${address}`
      });

    if (txError) throw txError;

    return new Response(JSON.stringify({ success: true, nuevoSaldo }), { status: 200 });

  } catch (error: any) {
    console.error("❌ Error en solicitud de retiro:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};