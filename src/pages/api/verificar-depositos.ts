import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { desencriptarClave } from '../../libs/encript';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL ;
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY ;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const BILLETERA_MAESTRA = import.meta.env.BILLETERA_MAESTRA_USDT || process.env.BILLETERA_MAESTRA_USDT ;

export const GET: APIRoute = async () => {
  try {
    console.log("=== INICIANDO ESCANEO MULTIRED DINÁMICO (SUPABASE + ALCHEMY) ===");

    // 1. Descargamos las redes activas desde Supabase
    const { data: redes, error: redesError } = await supabase
      .from('redes_config')
      .select('*')
      .eq('activa', true);

    if (redesError) throw redesError;
    if (!redes || redes.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No hay redes activas configuradas." }), { status: 200 });
    }

    // 2. Descargamos todas las billeteras de depósito asignadas
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica, llave_privada_encriptada'); 

    if (dbError) throw dbError;
    if (!billeteras || billeteras.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No hay billeteras para escanear." }), { status: 200 });
    }

    let globalesDetallesEscaneo = [];

    // 3. BUCLE PRINCIPAL: Iteramos sobre cada red de forma dinámica
    for (const red of redes) {
      console.log(`📡 Conectando a red: ${red.nombre}`);
      const provider = new ethers.JsonRpcProvider(red.rpc_url.replace(/["']/g, ""));
      
      const contratoUSDT = new ethers.Contract(red.usdt_contrato, [
        "function balanceOf(address account) external view returns (uint256)",
        "function transfer(address to, uint256 value) external returns (bool)"
      ], provider) as any;

      for (const wallet of billeteras) {
        let registro = {
          usuario_id: wallet.usuario_id,
          red: red.nombre,
          direccion: wallet.direccion_publica,
          balance_detectado: 0,
          acreditado: false,
          barrido_exitoso: false,
          tx_hash_barrido: null as string | null,
          error: null as string | null
        };

        try {
          const balanceEnBlockchain = await contratoUSDT.balanceOf(wallet.direccion_publica);
          const balanceRealUSDT = parseFloat(ethers.formatUnits(balanceEnBlockchain, red.decimales));
          registro.balance_detectado = balanceRealUSDT;

          if (balanceRealUSDT > 0) {
            console.log(`💰 ¡Depósito Detectado! ${balanceRealUSDT} USDT en ${red.nombre} para ${wallet.direccion_publica}`);

            const clavePrivadaDescifrada = desencriptarClave(wallet.llave_privada_encriptada);
            const walletSigner = new ethers.Wallet(clavePrivadaDescifrada, provider);
            const feeData = await provider.getFeeData();

            const { data: perfil } = await supabase
              .from('perfiles')
              .select('balance_virtual')
              .eq('id', wallet.usuario_id)
              .single();

            const balanceVirtualActual = parseFloat(perfil?.balance_virtual || "0");
            const nuevoBalanceVirtual = balanceVirtualActual + balanceRealUSDT;

            // Ejecutamos el BARRIDO AUTOMÁTICO
            const txBarrido = await contratoUSDT.connect(walletSigner).transfer(BILLETERA_MAESTRA, balanceEnBlockchain, {
              gasLimit: 65000, 
              maxFeePerGas: feeData.maxFeePerGas,
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
            });

            const reciboTx = await txBarrido.wait();

            if (reciboTx && reciboTx.status === 1) {
              await supabase
                .from('perfiles')
                .update({ balance_virtual: nuevoBalanceVirtual })
                .eq('id', wallet.usuario_id);

              await supabase
                .from('transacciones')
                .insert({
                  usuario_id: wallet.usuario_id,
                  tipo: 'deposito',
                  monto_virtual: balanceRealUSDT,
                  estado: 'completado',
                  hash_blockchain: txBarrido.hash
                });

              registro.acreditado = true;
              registro.barrido_exitoso = true;
              registro.tx_hash_barrido = txBarrido.hash;
            }
          }
        } catch (innerError: any) {
          console.error(`❌ Error procesando wallet ${wallet.direccion_publica} en ${red.nombre}:`, innerError.message);
          registro.error = innerError.message;
        }
        globalesDetallesEscaneo.push(registro);
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Escaneo y barrido multired dinámico completado.",
        resultados: globalesDetallesEscaneo 
      }), 
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Error crítico en el motor multired:", error.message);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
};