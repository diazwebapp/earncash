import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

// 1. Inicializamos las credenciales desde las variables de entorno
const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RPC_URL = import.meta.env.RPC_PROVIDER_URL || 'http://127.0.0.1:8545';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export const GET: APIRoute = async () => {
  try {
    // 2. Conectamos con el proveedor de la red local
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // 3. Obtenemos las billeteras registradas en el sistema
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica');

    if (dbError) throw dbError;
    if (!billeteras || billeteras.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No hay billeteras para escanear.", resultados: [] }), { status: 200 });
    }

    const detallesEscaneo = [];

    for (const wallet of billeteras) {
      // 4. Consultamos el balance virtual acumulado en Supabase (Tabla perfiles)
      const { data: perfil } = await supabase
        .from('perfiles')
        .select('balance_virtual')
        .eq('id', wallet.usuario_id)
        .single();

      // 5. Leemos el balance nativo del nodo de pruebas local usando el provider
      const balanceCrudo = await provider.getBalance(wallet.direccion_publica);
      const balanceETH = parseFloat(ethers.formatUnits(balanceCrudo, 18));

      // Construimos el reporte para este registro
      const registro = {
        usuario_id: wallet.usuario_id,
        direccion: wallet.direccion_publica,
        balance_virtual_actual: perfil?.balance_virtual || 0,
        balance_blockchain_usdt: balanceETH, // Muestra el balance de la red local
        acreditado: false
      };

      // 6. Si detectamos fondos mayores a 0, ejecutamos la acreditación
      if (balanceETH > 0) {
        const nuevoBalanceVirtual = (perfil?.balance_virtual || 0) + balanceETH;

        // Actualizamos el saldo virtual en la base de datos
        await supabase
          .from('perfiles')
          .update({ balance_virtual: nuevoBalanceVirtual })
          .eq('id', wallet.usuario_id);

        // Insertamos el historial de la transacción para el usuario
        await supabase
          .from('transacciones')
          .insert({
            usuario_id: wallet.usuario_id,
            tipo: 'deposito',
            monto: balanceETH,
            estado: 'completado',
            hash_blockchain: `LOCAL_NODE_TX_${Date.now()}`
          });

        // Actualizamos los valores del reporte actual para la pantalla
        registro.balance_virtual_actual = nuevoBalanceVirtual;
        registro.acreditado = true;
      }

      detallesEscaneo.push(registro);
    }

    // 7. Devolvemos el JSON completo al navegador
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Escaneo completado con éxito en el nodo local.",
        total_billeteras_escaneadas: detallesEscaneo.length,
        resultados: detallesEscaneo 
      }), 
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Error en el verificador local:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};