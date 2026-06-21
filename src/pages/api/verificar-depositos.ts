import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

// 1. Forzamos de manera estricta la lectura de las variables de entorno del servidor
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 2. Inicializamos el cliente de Supabase usando explícitamente la llave de servicio
if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ Alerta: Faltan las credenciales maestras de Supabase en el entorno.");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

// 3. Proveedor RPC del túnel
const RPC_URL = process.env.RPC_PROVIDER_URL || import.meta.env.RPC_PROVIDER_URL || "http://127.0.0.1:8545";

export const GET: APIRoute = async () => {
  try {
    // Conectamos con el proveedor
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Traemos las billeteras asignadas de Supabase
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica');

    if (dbError) throw dbError;
    if (!billeteras || billeteras.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No hay billeteras para escanear." }), { status: 200 });
    }

    const detallesEscaneo = [];

    for (const wallet of billeteras) {
      // Leemos el balance nativo del nodo local Hardhat
      const balanceCrudo = await provider.getBalance(wallet.direccion_publica);
      const balanceSimulado = parseFloat(ethers.formatUnits(balanceCrudo, 18));

      const registro = {
        usuario_id: wallet.usuario_id,
        direccion: wallet.direccion_publica,
        balance_blockchain_usdt: balanceSimulado,
        acreditado: false
      };

      if (balanceSimulado > 0) {
        // Obtenemos el balance virtual actual en Supabase
        const { data: perfil } = await supabase
          .from('perfiles')
          .select('balance_virtual')
          .eq('id', wallet.usuario_id)
          .single();

        const nuevoBalanceVirtual = (perfil?.balance_virtual || 0) + balanceSimulado;

        // 1. Actualizamos el saldo del perfil
        const { error: perfilError } = await supabase
          .from('perfiles')
          .update({ balance_virtual: nuevoBalanceVirtual })
          .eq('id', wallet.usuario_id);

        if (perfilError) {
          console.error(`❌ Error actualizando perfil de ${wallet.usuario_id}:`, perfilError.message);
        }

       // 2. Registramos la transacción con un hash 100% único e irrepetible
        const { error: txError } = await supabase
          .from('transacciones')
          .insert({
            usuario_id: wallet.usuario_id,
            tipo: 'deposito',
            monto_virtual: balanceSimulado,
            estado: 'completado',
            hash_blockchain: `LOCAL_${wallet.usuario_id.slice(0, 5)}_${Date.now()}_${Math.floor(Math.random() * 1000)}` // 👈 Forzamos unicidad absoluta
          });

        if (txError) {
          console.error(`❌ Error real de Supabase insertando transacción:`, txError.message);
        } else {
          registro.acreditado = true;
        }

      detallesEscaneo.push(registro);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Escaneo local completado con éxito.",
        total_billeteras_escaneadas: detallesEscaneo.length,
        resultados: detallesEscaneo 
      }), 
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Error en el escaneo local:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};