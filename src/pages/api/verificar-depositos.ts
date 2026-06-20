import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers, getAddress } from 'ethers';

// 1. Inicializamos Supabase con la Service Role Key para poder actualizar saldos sin restricciones de RLS
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// 2. Configuración de Web3 para la Testnet
const RPC_URL = import.meta.env.RPC_PROVIDER_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const USDT_CONTRACT_RAW = import.meta.env.USDT_CONTRACT_ADDRESS || "0x337610d27c682E347C9cD60BD4b3b107c9d34dDd";
const USDT_CONTRACT = getAddress(USDT_CONTRACT_RAW.toLowerCase()); // Convierte a formato válido seguro
// Un ABI mínimo que solo le dice a ethers cómo consultar el balance de un Token ERC20/BEP20
const MIN_ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

export const GET: APIRoute = async () => {
  try {
    // A. Conectar con la Blockchain a través del proveedor RPC
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // B. Crear la instancia del contrato inteligente de USDT de prueba
    const usdtContrato = new ethers.Contract(USDT_CONTRACT, MIN_ERC20_ABI, provider);

    // C. Traer todas las billeteras de depósito asignadas de la base de datos
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica');

    if (dbError) throw dbError;
    if (!billeteras || billeteras.length === 0) {
      return new Response(JSON.stringify({ message: "No hay billeteras que escanear." }), { status: 200 });
    }

    console.log(`🔎 Escaneando balances para ${billeteras.length} billeteras...`);

    // 🌟 1. Arreglo para almacenar el reporte detallado que irá a la pantalla
    const detallesEscaneo = [];

    for (const wallet of billeteras) {
      const balanceCrudo = await usdtContrato.balanceOf(wallet.direccion_publica);
      const balanceUSDT = parseFloat(ethers.formatUnits(balanceCrudo, 18));

      // Guardamos la información básica de lo que encontramos en la blockchain
      const registro = {
        usuario_id: wallet.usuario_id,
        direccion: wallet.direccion_publica,
        balance_blockchain_usdt: balanceUSDT,
        acreditado: false
      };

      if (balanceUSDT > 0) {
        // --- Lógica de base de datos que ya armamos ---
        const { data: perfil } = await supabase
          .from('perfiles')
          .select('balance_virtual')
          .eq('id', wallet.usuario_id)
          .single();

        const nuevoBalanceVirtual = (perfil?.balance_virtual || 0) + balanceUSDT;

        await supabase
          .from('perfiles')
          .update({ balance_virtual: nuevoBalanceVirtual })
          .eq('id', wallet.usuario_id);

        await supabase
          .from('transacciones')
          .insert({
            usuario_id: wallet.usuario_id,
            tipo: 'deposito',
            monto: balanceUSDT,
            estado: 'completado',
            hash_blockchain: `TESTNET_TX_${Date.now()}`
          });
        // ----------------------------------------------

        registro.acreditado = true;
      }

      // 🌟 2. Empujamos el registro del usuario al reporte
      detallesEscaneo.push(registro);
    }

    // 🌟 3. Devolvemos el reporte completo en el JSON de respuesta
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Escaneo completado con éxito.",
        total_billeteras_escaneadas: detallesEscaneo.length,
        resultados: detallesEscaneo // 🚀 Aquí verás los montos en la pantalla
      }), 
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Error en el verificador:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};