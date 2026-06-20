import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

// 1. Inicializamos Supabase con la Service Role Key para poder actualizar saldos sin restricciones de RLS
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// 2. Configuración de Web3 para la Testnet
const RPC_URL = import.meta.env.RPC_PROVIDER_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const USDT_CONTRACT = import.meta.env.USDT_CONTRACT_ADDRESS || "0x337610d27c682E347C9cD60BD4b3b107c9d34dDd";

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

    // D. Recorrer cada billetera y revisar su saldo en la blockchain
    for (const wallet of billeteras) {
      // Consultamos el balance crudo (en unidades wei)
      const balanceCrudo = await usdtContrato.balanceOf(wallet.direccion_publica);
      
      // Convertimos el balance usando los 18 decimales del token para leerlo en formato legible (ej. "10.5")
      const balanceUSDT = parseFloat(ethers.formatUnits(balanceCrudo, 18));

      if (balanceUSDT > 0) {
        console.log(`💰 ¡Se detectaron ${balanceUSDT} USDT en la wallet de usuario ${wallet.usuario_id}!`);
        
        // TODO: Aquí añadiremos en el próximo paso la lógica de:
        // 1. Sumar balance_virtual en perfiles.
        // 2. Crear fila en transacciones.
        // 3. Barrer los fondos a tu cuenta maestra.
      }
    }

    return new Response(JSON.stringify({ success: true, message: "Escaneo completado con éxito." }), { status: 200 });

  } catch (error: any) {
    console.error("❌ Error en el verificador:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};